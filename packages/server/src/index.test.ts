import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SsrServer } from './index.ts'
import { createServer, parseCookies, withTimeout } from './index.ts'

// A minimal production build: Vite manifest, one asset, and an SSR entry.
let root: string
let server: SsrServer

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-ssr-server-'))
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write(
    'dist/client/.vite/manifest.json',
    JSON.stringify({
      'src/main.tsx': { file: 'assets/main-1.js', imports: ['_shared-2.js'], isEntry: true },
      '_shared-2.js': { file: 'assets/shared-2.js', css: ['assets/app-3.css'] },
      'src/routes/a/page.tsx': { file: 'assets/page-4.js', imports: ['_shared-2.js'], css: ['assets/app-3.css'] },
    }),
  )
  write('dist/client/assets/main-1.js', 'export {}')
  write('dist/server/entry-server.js', 'export const hello = "world"')

  server = await createServer({
    root: pathToFileURL(`${root}/`),
    ssrEntry: 'src/entry-server.tsx',
    entries: { main: 'src/main.tsx' },
    dev: false,
    logLevel: 'silent',
  })
  // Routes must be added before the first request makes the instance ready.
  server.app.get('/nonce', (req) => server.nonce(req) ?? '')
  server.app.get('/html', (_req, reply) =>
    server.sendHtml(reply, { status: 404, body: Readable.from(['<p>gone</p>']), timing: { upstream: 1.25, shell: 3 } }),
  )
})

afterAll(async () => {
  await server.app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('production mode', () => {
  it('loads the built SSR entry named after the source entry', async () => {
    expect(await server.ssr<{ hello: string }>()).toMatchObject({ hello: 'world' })
  })

  it('resolves entry, deduplicated preloads and stylesheets from the manifest', () => {
    expect(server.assets('main', ['src/routes/a/page.tsx'])).toEqual({
      entry: '/assets/main-1.js',
      preloads: ['/assets/shared-2.js', '/assets/page-4.js'],
      css: ['/assets/app-3.css'],
    })
  })

  it('rejects unknown client entries', () => {
    expect(() => server.assets('nope')).toThrow('unknown client entry')
  })

  it('serves hashed assets as immutable', async () => {
    const res = await server.app.inject('/assets/main-1.js')
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
  })
})

describe('assembly', () => {
  it('adds security headers to every response', async () => {
    const res = await server.app.inject('/metrics')
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    })
  })

  it('exposes counters at /metrics', async () => {
    server.count('renders')
    server.count('renders')
    expect((await server.app.inject('/metrics')).json()).toMatchObject({ renders: 2 })
  })

  it('sends HTML streams with status and server-timing', async () => {
    const res = await server.app.inject('/html')
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['server-timing']).toBe('upstream;dur=1.3, shell;dur=3.0')
    expect(res.body).toBe('<p>gone</p>')
  })
})

describe('utilities', () => {
  it('parses and decodes cookies', () => {
    const req = { headers: { cookie: 'gt=a%20b; auth_token=x=y' } } as Parameters<typeof parseCookies>[0]
    expect(parseCookies(req)).toEqual({ gt: 'a b', auth_token: 'x=y' })
  })

  it('rejects when the promise outlives the timeout', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'slow')).rejects.toThrow('slow timed out')
    await expect(withTimeout(Promise.resolve(1), 10, 'fast')).resolves.toBe(1)
  })
})

describe('content security policy (production)', () => {
  it('sends a nonce-based CSP with a fresh nonce per request', async () => {
    let seen: string[] = []
    const res1 = await server.app.inject('/metrics')
    const res2 = await server.app.inject('/metrics')
    seen = [res1, res2].map((r) => String(r.headers['content-security-policy']))
    for (const csp of seen) {
      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}'/)
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
    }
    expect(seen[0]).not.toBe(seen[1])
  })

  it('exposes the request nonce that the CSP header carries', async () => {
    const res = await server.app.inject('/nonce')
    expect(String(res.headers['content-security-policy'])).toContain(`'nonce-${res.body}'`)
  })
})
