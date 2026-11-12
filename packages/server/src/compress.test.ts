import { randomBytes } from 'node:crypto'
import { brotliDecompressSync, createBrotliDecompress, createGunzip, gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createFlushingCompressor, negotiateEncoding } from './compress.ts'

describe('negotiateEncoding', () => {
  it.each([
    ['gzip, deflate, br', 'br'],
    ['gzip, deflate', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0', null],
    ['identity', null],
    [undefined, null],
    ['*', 'br'],
  ])('%s -> %s', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected)
  })
})

describe('createFlushingCompressor', () => {
  it.each([
    ['br', brotliDecompressSync],
    ['gzip', gunzipSync],
  ] as const)('round-trips %s', async (encoding, decompress) => {
    const z = createFlushingCompressor(encoding)
    const out: Buffer[] = []
    z.on('data', (d: Buffer) => out.push(d))
    const done = new Promise((r) => z.on('end', r))
    z.write('<!DOCTYPE html><body>shell')
    z.write('<div>boundary</div></body></html>')
    z.end()
    await done
    expect(decompress(Buffer.concat(out)).toString()).toBe(
      '<!DOCTYPE html><body>shell<div>boundary</div></body></html>',
    )
  })

  // Streaming must survive compression: each written chunk (a React flush)
  // is decodable before the stream ends.
  it.each([
    ['br', createBrotliDecompress],
    ['gzip', createGunzip],
  ] as const)('%s: the first chunk is decodable before the stream ends', async (encoding, createDecompress) => {
    const z = createFlushingCompressor(encoding)
    const d = createDecompress()
    z.pipe(d)
    const firstText = new Promise<string>((resolve) => d.once('data', (b: Buffer) => resolve(b.toString())))
    z.write('<!DOCTYPE html><body>shell')
    await expect(firstText).resolves.toBe('<!DOCTYPE html><body>shell')
    z.end('</body></html>')
  })
})

describe('createFlushingCompressor backpressure', () => {
  // React pauses on write() === false and resumes on 'drain'; compression
  // must pass both through.
  it.each(['br', 'gzip'] as const)('%s: signals a slow reader, then drains once it reads', async (encoding) => {
    const z = createFlushingCompressor(encoding)
    let full = false
    for (let i = 0; i < 64 && !full; i++) {
      full = !z.write(randomBytes(4096)) // incompressible
      await new Promise((r) => setImmediate(r))
    }
    expect(full).toBe(true)
    const drained = new Promise((r) => z.once('drain', r))
    z.resume()
    await expect(drained).resolves.toBeUndefined()
    z.destroy()
  })
})
