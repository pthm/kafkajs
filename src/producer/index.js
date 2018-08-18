const createRetry = require('../retry')
const createDefaultPartitioner = require('./partitioners/default')
const createSendMessages = require('./sendMessages')
const InstrumentationEventEmitter = require('../instrumentation/emitter')
const events = require('./instrumentationEvents')
const { CONNECT, DISCONNECT } = require('./instrumentationEvents')
const { KafkaJSNonRetriableError } = require('../errors')

const { values, keys } = Object
const eventNames = values(events)
const eventKeys = keys(events)
  .map(key => `producer.events.${key}`)
  .join(', ')

module.exports = ({
  cluster,
  logger: rootLogger,
  createPartitioner = createDefaultPartitioner,
  retry = { retries: 5 },
}) => {
  const partitioner = createPartitioner()
  const retrier = createRetry(Object.assign({}, cluster.retry, retry))
  const instrumentationEmitter = new InstrumentationEventEmitter()
  const logger = rootLogger.namespace('Producer')
  const sendMessages = createSendMessages({ logger, cluster, partitioner })

  /**
   * @typedef {Object} TopicMessages
   * @property {string} topic
   * @property {Array} messages An array of objects with "key" and "value", example:
   *                         [{ key: 'my-key', value: 'my-value'}]
   *
   * @typedef {Object} SendBatchRequest
   * @property {Array<TopicMessages>} topicMessages
   * @property {number} [acks=-1] Control the number of required acks.
   *                           -1 = all replicas must acknowledge
   *                            0 = no acknowledgments
   *                            1 = only waits for the leader to acknowledge
   * @property {number} [timeout=30000] The time to await a response in ms
   * @property {Compression.Types} [compression=Compression.Types.None] Compression codec
   *
   * @param {SendBatchRequest}
   * @returns {Promise}
   */
  const sendBatch = async ({ acks, timeout, compression, topicMessages = [] }) => {
    if (topicMessages.length === 0 || topicMessages.some(({ topic }) => !topic)) {
      throw new KafkaJSNonRetriableError(`Invalid topic`)
    }

    for (let { topic, messages } of topicMessages) {
      if (!messages) {
        throw new KafkaJSNonRetriableError(
          `Invalid messages array [${messages}] for topic "${topic}"`
        )
      }
    }

    return retrier(async (bail, retryCount, retryTime) => {
      try {
        return await sendMessages({
          acks,
          timeout,
          compression,
          topicMessages,
        })
      } catch (error) {
        if (!cluster.isConnected()) {
          logger.debug(`Cluster has disconnected, reconnecting: ${error.message}`, {
            retryCount,
            retryTime,
          })
          await cluster.connect()
          await cluster.refreshMetadata()
          throw error
        }

        // This is necessary in case the metadata is stale and the number of partitions
        // for this topic has increased in the meantime
        if (
          error.name === 'KafkaJSConnectionError' ||
          (error.name === 'KafkaJSProtocolError' && error.retriable)
        ) {
          logger.error(`Failed to send messages: ${error.message}`, { retryCount, retryTime })
          await cluster.refreshMetadata()
          throw error
        }

        // Skip retries for errors not related to the Kafka protocol
        logger.error(`${error.message}`, { retryCount, retryTime })
        bail(error)
      }
    })
  }

  /**
   * @param {ProduceRequest} ProduceRequest
   * @returns {Promise}
   *
   * @typedef {Object} ProduceRequest
   * @property {string} topic
   * @property {Array} messages An array of objects with "key" and "value", example:
   *                         [{ key: 'my-key', value: 'my-value'}]
   * @property {number} [acks=-1] Control the number of required acks.
   *                           -1 = all replicas must acknowledge
   *                            0 = no acknowledgments
   *                            1 = only waits for the leader to acknowledge
   * @property {number} [timeout=30000] The time to await a response in ms
   * @property {Compression.Types} [compression=Compression.Types.None] Compression codec
   */
  const send = async ({ acks, timeout, compression, topic, messages }) => {
    const topicMessage = { topic, messages }
    return sendBatch({
      acks,
      timeout,
      compression,
      topicMessages: [topicMessage],
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
   * @returns {Object} logger
   */
  const getLogger = () => logger

  return {
    /**
     * @returns {Promise}
     */
    connect: async () => {
      await cluster.connect()
      instrumentationEmitter.emit(CONNECT)
    },

    /**
     * @return {Promise}
     */
    disconnect: async () => {
      await cluster.disconnect()
      instrumentationEmitter.emit(DISCONNECT)
    },

    events,

    on,

    send,

    sendBatch,

    logger: getLogger,
  }
}
