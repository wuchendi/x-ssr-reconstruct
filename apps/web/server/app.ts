// The web app's server: app-specific routes on top of @x-ssr/server, which
// does the generic assembly (Fastify, security headers, metrics, static
// assets, dev/production SSR loading). Exported as create() so Platformatic
// Watt can run it on several worker threads; server/main.ts runs it standalone.
import { executeGraphQL, fetchFeatureFlags, fetchGuestToken } from '@x-ssr/mock-api'
import { createServer, type FastifyReply, type FastifyRequest, parseCookies, withTimeout } from '@x-ssr/server'
import { cleanPath } from '@x-ssr/url-cleanup'

type EntryServer = typeof import('../src/entry-server.tsx')
type Audience = 'person' | 'crawler' | 'preview'

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 1000)

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

  // Placeholder for media + the Rust card-image service.
  const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#16181c"/></svg>`
  app.get('/media/:file', (_req, reply) => reply.type('image/svg+xml').send(placeholder))

  // The browser's own GraphQL endpoint, used after the stream has ended.
  app.post('/i/api/graphql', async (req) => {
    const c = parseCookies(req)
    const body = req.body as { query: string; variables: Record<string, unknown> }
    return executeGraphQL(body, { guestToken: c.gt, userToken: c.auth_token })
  })

  app.get('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const [pathname, query] = req.url.split(/\?(.*)/s)
    const clean = cleanPath(pathname)
    if (clean) return reply.redirect(query ? `${clean}?${query}` : clean, 301)

    const t0 = performance.now()
    const audience = audienceOf(req)
    const c = parseCookies(req)
    const signedIn = Boolean(c.auth_token)

    // Logged out: guest token and feature flags in parallel. The flags
    // request doesn't use the token, so it must not wait for it.
    const [guestToken, flags] = await Promise.all([
      signedIn ? Promise.resolve(undefined) : withTimeout(fetchGuestToken(), UPSTREAM_TIMEOUT_MS, 'guest token'),
      withTimeout(fetchFeatureFlags({ country: String(req.headers['x-edge-country'] ?? 'US') }), UPSTREAM_TIMEOUT_MS, 'flags'),
    ])
    const t1 = performance.now()

    const ssr = await server.ssr<EntryServer>()
    const result = await ssr
      .render({
        url: req.url,
        audience,
        signedIn,
        flags,
        fetchGraphQL: (query, variables) =>
          withTimeout(executeGraphQL({ query, variables }, { guestToken, userToken: c.auth_token }), UPSTREAM_TIMEOUT_MS, 'graphql') as never,
        resolveAssets: (routeId, signedIn) => server.assets(signedIn ? 'signed-in' : 'logged-out', [`src/routes/${routeId}/page.tsx`]),
        onError: (err) => req.log.error({ err }, 'render error after shell'),
      })
      .catch((err: unknown) => {
        server.fixStacktrace(err)
        throw err
      })

    if (result.status === 'unowned') {
      // Production: the edge would have routed this path to rweb.
      return reply.code(404).type('text/plain').send('Not a route of the new app (edge would send this to rweb)')
    }

    server.count('renders')
    server.count(`renders.${audience}`)
    if (guestToken) reply.header('set-cookie', `gt=${guestToken}; Path=/; HttpOnly; SameSite=Lax`)
    reply.header('vary', 'cookie')
    return server.sendHtml(reply, {
      status: result.status,
      body: result.body,
      timing: { upstream: t1 - t0, shell: performance.now() - t1 },
    })
  })

  return app
}
