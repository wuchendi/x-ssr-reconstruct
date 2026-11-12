// The web app's server: app-specific routes on top of @x-ssr/server, which
// does the generic assembly (Fastify, security headers, metrics, static
// assets, dev/production SSR loading). Exported as create() so Platformatic
// Watt can run it on several worker threads; server/main.ts runs it standalone.
import type { FastifyReply, FastifyRequest } from '@x-ssr/server'
import { createServer, parseCookies } from '@x-ssr/server'
import { cleanPath } from '@x-ssr/url-cleanup'
import { createApiClient } from './api-client.ts'
import { CRAWLER_BYTE_BUDGET, withByteBudget } from './byte-budget.ts'

type EntryServer = typeof import('../src/entry-server.tsx')
type Audience = 'person' | 'crawler' | 'preview'

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 1000)
// The API tier (apps/api).
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3302'
// Test harness: forward x-debug-fail to the API (see apps/api). Off by default.
const DEBUG_FAILURES = process.env.DEBUG_FAILURES === '1'
// Boundaries still pending after this are handed to the browser.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 10_000)

const ERROR_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Something went wrong / X-ish</title>
<meta name="robots" content="noindex"></head><body><h1>Something went wrong</h1><p>Try again in a moment.</p></body></html>`

// The edge verifies search crawlers by IP (not User-Agent) and recognises
// link-preview bots, then tells us via a header it strips from client
// requests. Anything unverified, including a fake "Googlebot" UA from a
// random IP, is treated as a logged-out person.
function audienceOf(req: FastifyRequest): Audience {
  const v = req.headers['x-edge-verified-bot']
  return v === 'search' ? 'crawler' : v === 'preview' ? 'preview' : 'person'
}

export async function create() {
  const server = await createServer({
    root: new URL('../', import.meta.url),
    ssrEntry: 'src/entry-server.tsx',
    // Logged-out and signed-in visitors get separate entry points.
    entries: { 'logged-out': 'src/entries/logged-out.tsx', 'signed-in': 'src/entries/signed-in.tsx' },
    devCss: ['src/styles.css'],
  })
  const { app } = server
  const api = createApiClient(API_URL, UPSTREAM_TIMEOUT_MS)

  // Errors before the first byte (upstream timeouts, shell render errors):
  // pages get a plain HTML error page, API calls keep JSON. Errors after the
  // shell are handled by React (the boundary is client-rendered).
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    server.fixStacktrace(err)
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status >= 500) req.log.error({ err }, 'request failed')
    if (req.method !== 'GET')
      return reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message })
    return reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(ERROR_PAGE)
  })

  // Test hook for scripts/watt-stall-check.mjs: blocks this worker's event
  // loop like a stuck render, so Watt's health checks can be seen replacing
  // it. Only registered when DEBUG_STALL_ROUTE=1.
  if (process.env.DEBUG_STALL_ROUTE === '1') {
    app.get('/__debug/stall', (req) => {
      const ms = Number((req.query as { ms?: string }).ms ?? 60_000)
      const end = Date.now() + ms
      while (Date.now() < end) {
        // Busy-wait: nothing else can run on this thread.
      }
      return { stalledMs: ms }
    })
  }

  // Placeholder for media + the Rust card-image service.
  const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#16181c"/></svg>`
  app.get('/media/:file', (_req, reply) => reply.type('image/svg+xml').send(placeholder))

  // Stand-in for the edge's path routing: /i/api/* on the site's origin
  // belongs to the API tier. In production the edge sends it there directly.
  app.route({
    method: ['GET', 'POST'],
    url: '/i/api/*',
    handler: async (req, reply) => {
      const headers: Record<string, string> = {}
      for (const name of DEBUG_FAILURES ? ['content-type', 'cookie', 'x-debug-fail'] : ['content-type', 'cookie']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      const res = await fetch(new URL(req.url, API_URL), {
        method: req.method,
        headers,
        body: req.method === 'GET' ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      reply.code(res.status)
      const type = res.headers.get('content-type')
      if (type) reply.type(type)
      return reply.send(Buffer.from(await res.arrayBuffer()))
    },
  })

  app.get('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const [pathname, query] = req.url.split(/\?(.*)/s)
    const clean = cleanPath(pathname)
    if (clean) return reply.redirect(query ? `${clean}?${query}` : clean, 301)

    const t0 = performance.now()
    // The client went away before the response finished: stop rendering and
    // cancel upstream calls instead of finishing work nobody will read.
    const disconnected = new AbortController()
    reply.raw.on('close', () => {
      if (reply.raw.writableFinished) return
      server.count('renders.aborted')
      disconnected.abort(new Error('client disconnected'))
    })
    const audience = audienceOf(req)
    const c = parseCookies(req)
    const signedIn = Boolean(c.auth_token)
    const debugFail = DEBUG_FAILURES ? req.headers['x-debug-fail'] : undefined

    // Logged out: guest token and feature flags in parallel. The flags
    // request doesn't use the token, so it must not wait for it.
    const [guestToken, flags] = await Promise.all([
      signedIn ? Promise.resolve(undefined) : api.guestToken(disconnected.signal),
      api.flags(String(req.headers['x-edge-country'] ?? 'US'), disconnected.signal),
    ])
    const t1 = performance.now()

    const ssr = await server.ssr<EntryServer>()
    const result = await ssr.render({
      url: req.url,
      audience,
      signedIn,
      flags,
      fetchGraphQL: (id, variables, signal) =>
        api.graphql(
          id,
          variables,
          { guestToken, userToken: c.auth_token, debugFail: typeof debugFail === 'string' ? debugFail : undefined },
          signal,
        ),
      resolveAssets: (routeId, signedIn) =>
        server.assets(signedIn ? 'signed-in' : 'logged-out', [`src/routes/${routeId}/page.tsx`]),
      onError: (err) => req.log.error({ err }, 'render error after shell'),
      nonce: server.nonce(req),
      signal: disconnected.signal,
      renderTimeoutMs: RENDER_TIMEOUT_MS,
    })

    if (result.status === 'unowned') {
      // Production: the edge would have routed this path to rweb.
      return reply.code(404).type('text/plain').send('Not a route of the new app (edge would send this to rweb)')
    }

    server.count('renders')
    server.count(`renders.${audience}`)
    if (guestToken) reply.header('set-cookie', `gt=${guestToken}; Path=/; HttpOnly; SameSite=Lax`)
    reply.header('vary', 'cookie')
    const body =
      audience === 'crawler'
        ? withByteBudget(result.body, CRAWLER_BYTE_BUDGET, (bytes) => {
            server.count('crawler.over_budget')
            req.log.warn({ url: req.url, bytes }, 'crawler document over the 2 MB budget Googlebot reads')
          })
        : result.body
    return server.sendHtml(reply, {
      status: result.status,
      body,
      timing: { upstream: t1 - t0, shell: performance.now() - t1 },
    })
  })

  return app
}
