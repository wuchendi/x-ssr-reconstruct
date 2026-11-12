// HTML compression that keeps streaming intact. A plain compressor buffers
// until it has enough input, which would hold back the shell and every
// Suspense boundary. The body stream writes exactly one chunk per React
// flush (see the web app's ResponseInjector), so the compressor is flushed
// after every chunk: each reaches the browser as soon as React produced it.
import type { TransformCallback } from 'node:stream'
import { Transform } from 'node:stream'
import type { BrotliCompress, Gzip } from 'node:zlib'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'

export type Encoding = 'br' | 'gzip'

// Picks br over gzip; "q=0" refuses an encoding.
export function negotiateEncoding(header: string | undefined): Encoding | null {
  if (!header) return null
  const accepted = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    accepted.set(name, q ? Number(q.slice(2)) : 1)
  }
  const ok = (name: Encoding) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0
  if (ok('br')) return 'br'
  if (ok('gzip')) return 'gzip'
  return null
}

class FlushingCompressor extends Transform {
  #z: BrotliCompress | Gzip

  constructor(z: BrotliCompress | Gzip) {
    super()
    this.#z = z
    z.on('data', (d: Buffer) => this.push(d))
    z.on('error', (e) => this.destroy(e))
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.#z.write(chunk)
    this.#z.flush(() => cb())
  }

  override _flush(cb: TransformCallback) {
    this.#z.once('end', () => cb())
    this.#z.end()
  }
}

export function createFlushingCompressor(encoding: Encoding): Transform {
  // Quality 4: compressing on the fly, the default (11) costs too much time.
  const z =
    encoding === 'br'
      ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : createGzip({ level: 6 })
  return new FlushingCompressor(z)
}
