// Analogue of X's internal @x-clients/server: one Fastify app assembled from
// configuration (security headers, cookies, metrics, streaming render,
// graceful shutdown). Exported as create() so Platformatic Watt can run it on
// several worker threads; server/main.ts runs it standalone.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { executeGraphQL, fetchFeatureFlags, fetchGuestToken } from './backend.ts'
import { cleanPath } from './url-cleanup.ts'

type Audience = 'person' | 'crawler' | 'preview'
type Manifest = Record<string, { file: string; css?: string[]; imports?: string[]; isEntry?: boolean; src?: string }>

const root = new URL('../dist/', import.meta.url)
const manifest: Manifest = JSON.parse(readFileSync(new URL('client/.vite/manifest.json', root), 'utf8'))
const ssr: typeof import('../src/entry-server.tsx') = await import(new URL('server/entry-server.js', root).href)

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 1000)

// --- assets -----------------------------------------------------------------

function collect(key: string, out: { js: Set<string>; css: Set<string> }) {
  const chunk = manifest[key]
  if (!chunk || out.js.has(`/${chunk.file}`)) return
  out.js.add(`/${chunk.file}`)
  for (const c of chunk.css ?? []) out.css.add(`/${c}`)
  for (const imp of chunk.imports ?? []) collect(imp, out)
}

type RouteAssets = { entry: string; preloads: string[]; css: string[] }
const assetCache = new Map<string, RouteAssets>()
function resolveAssets(routeId: string, signedIn: boolean): RouteAssets {
  const cacheKey = `${routeId}|${signedIn}`
  const hit = assetCache.get(cacheKey)
  if (hit) return hit
  const entryKey = signedIn ? 'src/entries/signed-in.tsx' : 'src/entries/logged-out.tsx'
  const entry = { js: new Set<string>(), css: new Set<string>() }
  collect(entryKey, entry)
  const page = { js: new Set<string>(), css: new Set<string>() }
  collect(`src/routes/${routeId}/page.tsx`, page)
  const entryFile = `/${manifest[entryKey].file}`
  const result = {
    entry: entryFile,
    // Startup chunks plus the chunks of the route the server just rendered.
    preloads: [...new Set([...entry.js, ...page.js])].filter((f) => f !== entryFile),
    css: [...new Set([...entry.css, ...page.css])],
  }
  assetCache.set(cacheKey, result)
  return result
}

// --- edge contract ----------------------------------------------------------

// The edge verifies search crawlers by IP (not User-Agent) and recognises
// link-preview bots, then tells us via a header it strips from client
// requests. Anything unverified, including a fake "Googlebot" UA from a
// random IP, is treated as a logged-out person.
function audienceOf(req: FastifyRequest): Audience {
  const v = req.headers['x-edge-verified-bot']
  return v === 'search' ? 'crawler' : v === 'preview' ? 'preview' : 'person'
}

function cookies(req: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  )
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // NB: on a saturated event loop this timer can fire before an
  // already-arrived response is processed. The fix in the post was more
  // workers (lower per-loop utilisation), not a longer timeout.
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))])
}

// --- app --------------------------------------------------------------------

export async function create() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, return503OnClosing: true })
  const metrics = { renders: 0, byAudience: { person: 0, crawler: 0, preview: 0 } as Record<Audience, number> }

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('x-frame-options', 'DENY')
  })

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('client/assets/', root)),
    prefix: '/assets/',
    immutable: true,
    maxAge: '1y',
    preCompressed: true,
  })

  app.get('/metrics', async () => metrics)

  // Placeholder for media + the Rust card-image service.
  const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#16181c"/></svg>`
  app.get('/media/:file', (_req, reply) => reply.type('image/svg+xml').send(placeholder))

  // The browser's own GraphQL endpoint, used after the stream has ended.
  app.post('/i/api/graphql', async (req) => {
    const c = cookies(req)
    const body = req.body as { query: string; variables: Record<string, unknown> }
    return executeGraphQL(body, { guestToken: c.gt, userToken: c.auth_token })
  })

  app.get('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const [pathname, query] = req.url.split(/\?(.*)/s)
    const clean = cleanPath(pathname)
    if (clean) return reply.redirect(query ? `${clean}?${query}` : clean, 301)

    const t0 = performance.now()
    const audience = audienceOf(req)
    const c = cookies(req)
    const signedIn = Boolean(c.auth_token)

    // Logged out: guest token and feature flags in parallel. The flags
    // request doesn't use the token, so it must not wait for it.
    const [guestToken, flags] = await Promise.all([
      signedIn ? Promise.resolve(undefined) : withTimeout(fetchGuestToken(), UPSTREAM_TIMEOUT_MS, 'guest token'),
      withTimeout(fetchFeatureFlags({ country: String(req.headers['x-edge-country'] ?? 'US') }), UPSTREAM_TIMEOUT_MS, 'flags'),
    ])
    const t1 = performance.now()

    const result = await ssr.render({
      url: req.url,
      audience,
      signedIn,
      flags,
      fetchGraphQL: (query, variables) =>
        withTimeout(executeGraphQL({ query, variables }, { guestToken, userToken: c.auth_token }), UPSTREAM_TIMEOUT_MS, 'graphql') as never,
      resolveAssets,
      onError: (err) => req.log.error({ err }, 'render error after shell'),
    })

    if (result.status === 'unowned') {
      // Production: the edge would have routed this path to rweb.
      return reply.code(404).type('text/plain').send('Not a route of the new app (edge would send this to rweb)')
    }

    metrics.renders++
    metrics.byAudience[audience]++
    if (guestToken) reply.header('set-cookie', `gt=${guestToken}; Path=/; HttpOnly; SameSite=Lax`)
    return reply
      .code(result.status)
      .type('text/html; charset=utf-8')
      .header('vary', 'cookie')
      .header('server-timing', `upstream;dur=${(t1 - t0).toFixed(1)}, shell;dur=${(performance.now() - t1).toFixed(1)}`)
      .send(result.body)
  })

  return app
}
