const Decoder = require('../../../decoder')
const { parse: parseV1 } = require('../v1/response')
const MessageSetDecoder = require('../../../messageSet/decoder')
const RecordBatchDecoder = require('../../../recordBatch/v0/decoder')
const { MAGIC_BYTE } = require('../../../recordBatch/v0')

// the magic offset is at the same offset for all current message formats, but the 4 bytes
// between the size and the magic is dependent on the version.
const MAGIC_OFFSET = 16

/**
 * Fetch Response (Version: 4) => throttle_time_ms [responses]
 *   throttle_time_ms => INT32
 *   responses => topic [partition_responses]
 *     topic => STRING
 *     partition_responses => partition_header record_set
 *       partition_header => partition error_code high_watermark last_stable_offset [aborted_transactions]
 *         partition => INT32
 *         error_code => INT16
 *         high_watermark => INT64
 *         last_stable_offset => INT64
 *         aborted_transactions => producer_id first_offset
 *           producer_id => INT64
 *           first_offset => INT64
 *       record_set => RECORDS
 */

const decodeMessages = async decoder => {
  const messagesSize = decoder.readInt32()

  if (messagesSize <= 0 || !decoder.canReadBytes(messagesSize)) {
    return []
  }

  const messagesBuffer = decoder.readBytes(messagesSize)
  const magicByte = messagesBuffer.slice(MAGIC_OFFSET).readInt8()

  if (magicByte === MAGIC_BYTE) {
    const recordBatch = await RecordBatchDecoder(new Decoder(messagesBuffer))
    return recordBatch.records
  }

  return MessageSetDecoder(decoder)
}

const decodeAbortedTransactions = decoder => ({
  producerId: decoder.readInt64().toString(),
  firstOffset: decoder.readInt64().toString(),
})

const decodePartition = async decoder => ({
  partition: decoder.readInt32(),
  errorCode: decoder.readInt16(),
  highWatermark: decoder.readInt64().toString(),
  lastStableOffset: decoder.readInt64().toString(),
  abortedTransactions: decoder.readArray(decodeAbortedTransactions),
  messages: await decodeMessages(decoder),
})

const decodeResponse = async decoder => ({
  topicName: decoder.readString(),
  partitions: await decoder.readArrayAsync(decodePartition),
})

const decode = async rawData => {
  const decoder = new Decoder(rawData)
  const throttleTime = decoder.readInt32()
  const responses = await decoder.readArrayAsync(decodeResponse)

  return {
    throttleTime,
    responses,
  }
}

module.exports = {
  decode,
  parse: parseV1,
}
