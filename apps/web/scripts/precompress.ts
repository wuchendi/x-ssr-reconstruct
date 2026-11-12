// The asset CDN serves compressed files; mimic it with precompressed siblings.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const dir = new URL('../dist/client/assets/', import.meta.url)
for (const f of readdirSync(dir)) {
  if (!/\.(js|css)$/.test(f)) continue
  const buf = readFileSync(new URL(f, dir))
  writeFileSync(new URL(`${f}.br`, dir), brotliCompressSync(buf))
  writeFileSync(new URL(`${f}.gz`, dir), gzipSync(buf, { level: 9 }))
}
