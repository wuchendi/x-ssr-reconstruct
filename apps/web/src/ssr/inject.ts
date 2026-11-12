import type { TransformCallback } from 'node:stream'
import { Transform } from 'node:stream'

// Sits between React's Fizz writer and the socket.
//
// React writes in fixed-size views, so a single write() can end mid-tag. The
// only safe places to splice our own HTML are the points where React calls
// destination.flush() (end of each flush cycle: shell, each completed
// Suspense boundary, and the final </body></html>). We buffer React's bytes
// and emit them, together with any GraphQL responses that arrived meanwhile,
// at those points.
const DOC_END = Buffer.from('</body></html>')

export class ResponseInjector extends Transform {
  #react: Buffer[] = []
  #data: string[] = []
  #shellSent = false
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

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.#react.push(chunk)
    cb()
  }

  // Called by React (react-dom/server: flushBuffered -> destination.flush()).
  flush() {
    const react = Buffer.concat(this.#react)
    this.#react = []
    const data = this.#data.join('')
    this.#data = []
    if (!this.#shellSent) {
      // Nothing may precede <!DOCTYPE html>: responses that arrived before the
      // shell go right after it -- but still inside <body> when the shell is
      // the whole document (no pending boundaries).
      this.#shellSent = true
      if (data && react.subarray(-DOC_END.length).equals(DOC_END)) {
        this.push(react.subarray(0, -DOC_END.length))
        this.push(data)
        this.push(DOC_END)
      } else {
        this.push(react)
        if (data) this.push(data)
      }
    } else {
      // Data first, then the boundary that renders it, so the browser has the
      // response before React reveals and hydrates that boundary.
      if (data) this.push(data)
      if (react.length) this.push(react)
    }
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
