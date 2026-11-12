import type { TransformCallback } from 'node:stream'
import { Transform } from 'node:stream'

// Sits between React's Fizz writer and the socket.
//
// React writes in fixed-size views, so a single write() can end mid-tag. The
// only safe places to splice our own HTML are the points where React calls
// destination.flush(): the end of each flush cycle (the shell, each completed
// Suspense boundary, and the final </body></html>).
//
// React's own bytes pass straight through as they arrive. That keeps
// Transform's backpressure intact: when the reader falls behind, write()
// returns false and React pauses until 'drain', instead of us buffering the
// whole page for a slow client. Only our data scripts wait for a flush point.
// The last bytes of a cycle are held back, so that at the final flush the
// data can still go before </body></html>.
const DOC_END = Buffer.from('</body></html>')

export class ResponseInjector extends Transform {
  #data: string[] = []
  #tail: Buffer = Buffer.alloc(0)
  #shellSent = false
  #inCycle = false
  #nonceAttr: string

  // nonce: the response's CSP nonce, for the executable __rr.p() script. The
  // JSON block is data, not script, so CSP doesn't apply to it.
  constructor(nonce?: string) {
    super()
    this.#nonceAttr = nonce ? ` nonce="${escapeAttr(nonce)}"` : ''
  }

  pushResponse(key: string, json: string) {
    this.#data.push(
      `<script type="application/json" data-rr="${escapeAttr(key)}">${escapeScriptText(json)}</script><script${this.#nonceAttr}>__rr.p()</script>`,
    )
  }

  #takeData() {
    const data = this.#data.join('')
    this.#data = []
    return data
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    if (!this.#inCycle) {
      this.#inCycle = true
      // A new cycle starts right after a flush point: responses that arrived
      // in between go first, before the boundary that renders them. (Before
      // the shell nothing may precede <!DOCTYPE html>; those wait for flush.)
      if (this.#shellSent) {
        const data = this.#takeData()
        if (data) this.push(data)
      }
    }
    const bytes = Buffer.concat([this.#tail, chunk])
    const keep = Math.min(DOC_END.length, bytes.length)
    if (bytes.length > keep) this.push(bytes.subarray(0, bytes.length - keep))
    this.#tail = bytes.subarray(bytes.length - keep)
    cb()
  }

  // Called by React (react-dom/server: flushBuffered -> destination.flush()).
  flush() {
    this.#inCycle = false
    this.#shellSent = true
    const tail = this.#tail
    this.#tail = Buffer.alloc(0)
    const data = this.#takeData()
    // The document is complete: data still goes inside <body>.
    if (data && tail.equals(DOC_END)) {
      this.push(data)
      this.push(tail)
      return
    }
    if (tail.length) this.push(tail)
    if (data) this.push(data)
  }

  override _flush(cb: TransformCallback) {
    this.flush()
    cb()
  }
}

// JSON inside <script>: "</script" or "<!--" in user text must not end the
// element. \u003c is still valid JSON; U+2028/2029 are escaped for old parsers.
const escapeScriptText = (s: string) =>
  s
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
