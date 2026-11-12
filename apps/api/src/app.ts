// The API tier, as a service of its own. The browser reaches it at
// /i/api/* on the site's own origin (the edge routes that path here); the web
// server's SSR calls it directly. Data comes from @x-ssr/mock-api.
import { executeGraphQL, fetchFeatureFlags, fetchGuestToken } from '@x-ssr/mock-api'
import type { FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { loadPersistedQueries, parsePersistedRequest } from './persisted-queries.ts'

export type ApiOptions = {
  // relay-compiler's { id: query text } map for the web app's operations.
  persistedQueries: URL
  // Re-read the map on every lookup (dev, where codegen rewrites it).
  reload: boolean
  logLevel?: string
  // Test harness: operations named in the x-debug-fail header answer 503,
  // so error recovery can be exercised end to end. Off unless enabled.
  debugFailures?: boolean
}

function cookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

// Browsers send cookies; the SSR server, calling server-to-server, sends the
// guest token it just obtained as a header.
function authOf(req: FastifyRequest) {
  const header = req.headers['x-guest-token']
  return {
    guestToken: (typeof header === 'string' ? header : undefined) ?? cookie(req, 'gt'),
    userToken: cookie(req, 'auth_token'),
  }
}

function failsOnPurpose(req: FastifyRequest, query: string) {
  const header = req.headers['x-debug-fail']
  const name = /^\s*query\s+(\w+)/.exec(query)?.[1]
  return typeof header === 'string' && name !== undefined && header.split(',').some((n) => n.trim() === name)
}

export async function create(options: ApiOptions) {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    return503OnClosing: true,
  })
  const persisted = loadPersistedQueries(options.persistedQueries, { reload: options.reload })

  app.post('/i/api/1.1/guest/activate.json', async () => ({ guest_token: await fetchGuestToken() }))

  app.get('/i/api/flags', async (req) => {
    const country = String((req.query as { country?: string }).country ?? 'US')
    return fetchFeatureFlags({ country })
  })

  // Only persisted operations: { id, variables }. Query text is refused.
  app.post('/i/api/graphql', async (req, reply) => {
    const request = parsePersistedRequest(req.body)
    const query = request && persisted.get(request.id)
    if (!request || !query) return reply.code(400).send({ error: 'Unknown or malformed persisted query' })
    if (options.debugFailures && failsOnPurpose(req, query)) return reply.code(503).send({ error: 'debug failure' })
    return executeGraphQL({ query, variables: request.variables }, authOf(req))
  })

  return app
}
