const createRetry = require('../retry')
const waitFor = require('../utils/waitFor')
const createConsumer = require('../consumer')
const InstrumentationEventEmitter = require('../instrumentation/emitter')
const events = require('./instrumentationEvents')
const { CONNECT, DISCONNECT } = require('./instrumentationEvents')
const { LEVELS } = require('../loggers')
const { KafkaJSNonRetriableError } = require('../errors')

const { values, keys } = Object
const eventNames = values(events)
const eventKeys = keys(events)
  .map(key => `admin.events.${key}`)
  .join(', ')

const retryOnLeaderNotAvailable = (fn, opts = {}) => {
  const callback = async () => {
    try {
      return await fn()
    } catch (e) {
      if (e.type !== 'LEADER_NOT_AVAILABLE') {
        throw e
      }
      return false
    }
  }

  return waitFor(callback, opts)
}

const isConsumerGroupRunning = description => ['Empty', 'Dead'].includes(description.state)
const findTopicPartitions = async (cluster, topic) => {
  await cluster.addTargetTopic(topic)
  await cluster.refreshMetadataIfNecessary()

  return cluster
    .findTopicPartitionMetadata(topic)
    .map(({ partitionId }) => partitionId)
    .sort()
}

module.exports = ({ retry = { retries: 5 }, logger: rootLogger, cluster }) => {
  const logger = rootLogger.namespace('Admin')
  const instrumentationEmitter = new InstrumentationEventEmitter()

  /**
   * @returns {Promise}
   */
  const connect = async () => {
    await cluster.connect()
    instrumentationEmitter.emit(CONNECT)
  }

  /**
   * @return {Promise}
   */
  const disconnect = async () => {
    await cluster.disconnect()
    instrumentationEmitter.emit(DISCONNECT)
  }

  /**
   * @param {array} topics
   * @param {boolean} [validateOnly=false]
   * @param {number} [timeout=5000]
   * @param {boolean} [waitForLeaders=true]
   * @return {Promise}
   */
  const createTopics = async ({ topics, validateOnly, timeout, waitForLeaders = true }) => {
    if (!topics || !Array.isArray(topics)) {
      throw new KafkaJSNonRetriableError(`Invalid topics array ${topics}`)
    }

    if (topics.filter(({ topic }) => typeof topic !== 'string').length > 0) {
      throw new KafkaJSNonRetriableError(
        'Invalid topics array, the topic names have to be a valid string'
      )
    }

    const topicNames = new Set(topics.map(({ topic }) => topic))
    if (topicNames.size < topics.length) {
      throw new KafkaJSNonRetriableError(
        'Invalid topics array, it cannot have multiple entries for the same topic'
      )
    }

    const retrier = createRetry(retry)

    return retrier(async (bail, retryCount, retryTime) => {
      try {
        await cluster.refreshMetadata()
        const broker = await cluster.findControllerBroker()
        await broker.createTopics({ topics, validateOnly, timeout })

        if (waitForLeaders) {
          const topicNamesArray = Array.from(topicNames.values())
          await retryOnLeaderNotAvailable(async () => await broker.metadata(topicNamesArray), {
            delay: 100,
            timeoutMessage: 'Timed out while waiting for topic leaders',
          })
        }

        return true
      } catch (e) {
        if (e.type === 'NOT_CONTROLLER') {
          logger.warn('Could not create topics', { error: e.message, retryCount, retryTime })
          throw e
        }

        if (e.type === 'TOPIC_ALREADY_EXISTS') {
          return false
        }

        bail(e)
      }
    })
  }

  /**
   * @param {string} groupId
   * @param {string} topic
   * @return {Promise}
   */
  const fetchOffsets = async ({ groupId, topic }) => {
    if (!groupId) {
      throw new KafkaJSNonRetriableError(`Invalid groupId ${groupId}`)
    }

    if (!topic) {
      throw new KafkaJSNonRetriableError(`Invalid topic ${topic}`)
    }

    const partitions = await findTopicPartitions(cluster, topic)
    const coordinator = await cluster.findGroupCoordinator({ groupId })
    const partitionsToFetch = partitions.map(partition => ({ partition }))

    const { responses } = await coordinator.offsetFetch({
      groupId,
      topics: [{ topic, partitions: partitionsToFetch }],
    })

    return responses
      .filter(response => response.topic === topic)
      .map(({ partitions }) => partitions.map(({ partition, offset }) => ({ partition, offset })))
      .pop()
  }

  /**
   * @param {string} groupId
   * @param {string} topic
   * @param {boolean} [earliest=false]
   * @return {Promise}
   */
  const resetOffsets = async ({ groupId, topic, earliest = false }) => {
    if (!groupId) {
      throw new KafkaJSNonRetriableError(`Invalid groupId ${groupId}`)
    }

    if (!topic) {
      throw new KafkaJSNonRetriableError(`Invalid topic ${topic}`)
    }

    const partitions = await findTopicPartitions(cluster, topic)
    const partitionsToSeek = partitions.map(partition => ({
      partition,
      offset: cluster.defaultOffset({ fromBeginning: earliest }),
    }))

    return setOffsets({ groupId, topic, partitions: partitionsToSeek })
  }

  /**
   * @param {string} groupId
   * @param {string} topic
   * @param {Array<SeekEntry>} partitions
   * @return {Promise}
   *
   * @typedef {Object} SeekEntry
   * @property {number} partition
   * @property {string} offset
   */
  const setOffsets = async ({ groupId, topic, partitions }) => {
    if (!groupId) {
      throw new KafkaJSNonRetriableError(`Invalid groupId ${groupId}`)
    }

    if (!topic) {
      throw new KafkaJSNonRetriableError(`Invalid topic ${topic}`)
    }

    if (!partitions || partitions.length === 0) {
      throw new KafkaJSNonRetriableError(`Invalid partitions`)
    }

    const consumer = createConsumer({
      logger: rootLogger.namespace('Admin', LEVELS.NOTHING),
      cluster,
      groupId,
    })

    await consumer.subscribe({ topic, fromBeginning: true })
    const description = await consumer.describeGroup()

    if (!isConsumerGroupRunning(description)) {
      throw new KafkaJSNonRetriableError(
        `The consumer group must have no running instances, current state: ${description.state}`
      )
    }

    return new Promise((resolve, reject) => {
      consumer.on(consumer.events.FETCH, async () =>
        consumer
          .stop()
          .then(resolve)
          .catch(reject)
      )

      consumer
        .run({
          eachBatchAutoResolve: false,
          eachBatch: async () => true,
        })
        .catch(reject)

      // This consumer doesn't need to consume any data
      consumer.pause([{ topic }])

      for (let seekData of partitions) {
        consumer.seek({ topic, ...seekData })
      }
    })
  }

  /**
   * @param {string} eventName
   * @param {Function} listener
   * @return {Function}
   */
  const on = (eventName, listener) => {
    if (!eventNames.includes(eventName)) {
      throw new KafkaJSNonRetriableError(`Event name should be one of ${eventKeys}`)
    }

    return instrumentationEmitter.addListener(eventName, event => {
      Promise.resolve(listener(event)).catch(e => {
        logger.error(`Failed to execute listener: ${e.message}`, {
          eventName,
          stack: e.stack,
        })
      })
    })
  }

  /**
   * @return {Object} logger
   */
  const getLogger = () => logger

  return {
    connect,
    disconnect,
    createTopics,
    events,
    fetchOffsets,
    on,
    setOffsets,
    resetOffsets,
    logger: getLogger,
  }
}
