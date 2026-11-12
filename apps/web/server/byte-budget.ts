// Googlebot reads only the first 2 MB of a response; replies past the cut are
// lost and the structured data points at posts it never saw. Crawler
// documents are measured (uncompressed, as the HTML Google parses) and an
// oversized one is reported.
//
// Counting happens in a Transform: a 'data' listener would switch the
// stream to flowing mode and drop bytes emitted before the response starts
// reading (Fastify reads only after its async onSend hooks).
import type { Readable, TransformCallback } from 'node:stream'
import { pipeline, Transform } from 'node:stream'

export const CRAWLER_BYTE_BUDGET = 2 * 1024 * 1024

export function withByteBudget(body: Readable, budget: number, onExceed: (bytes: number) => void): Readable {
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      bytes += chunk.length
      cb(null, chunk)
    },
    flush(cb: TransformCallback) {
      if (bytes > budget) onExceed(bytes)
      cb()
    },
  })
  // pipeline: an error on either side destroys the other.
  return pipeline(body, counter, () => {})
}
