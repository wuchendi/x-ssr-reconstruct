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

// "OpName" -> HTTP 503; "OpName:graphql" -> a 200 whose error bubbled up and
// nulled the root field (what a failing non-null field produces).
function debugFailure(req: FastifyRequest, query: string): 'http' | 'graphql' | null {
  const header = req.headers['x-debug-fail']
  const name = /^\s*query\s+(\w+)/.exec(query)?.[1]
  if (typeof header !== 'string' || !name) return null
  for (const entry of header.split(',').map((e) => e.trim())) {
    if (entry === name) return 'http'
    if (entry === `${name}:graphql`) return 'graphql'
  }
  return null
}

// Degradation only the browser sees: a boundary the server couldn't finish,
// a section or page error, a failed navigation. Fixed types keep the
// counters bounded; the endpoint is public, so the payload is small and
// validated.
const CLIENT_EVENT_TYPES = ['recoverable-error', 'section-error', 'page-error', 'navigation-failed'] as const
type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number]

function parseClientEvent(body: unknown): { type: ClientEventType; route?: string; detail?: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const { type, route, detail } = body as Record<string, unknown>
  if (!CLIENT_EVENT_TYPES.includes(type as ClientEventType)) return null
  if (route !== undefined && (typeof route !== 'string' || route.length > 200)) return null
  if (detail !== undefined && (typeof detail !== 'string' || detail.length > 500)) return null
  return { type: type as ClientEventType, route, detail }
}

export async function create(options: ApiOptions) {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env.LOG_LEVEL ?? 'info' },
    return503OnClosing: true,
  })
  const persisted = loadPersistedQueries(options.persistedQueries, { reload: options.reload })
  const clientEvents = Object.fromEntries(CLIENT_EVENT_TYPES.map((t) => [t, 0])) as Record<ClientEventType, number>

  app.post('/i/api/client-events', { bodyLimit: 4096 }, async (req, reply) => {
    const event = parseClientEvent(req.body)
    if (!event) return reply.code(400).send({ error: 'Unknown or malformed client event' })
    clientEvents[event.type]++
    req.log.warn({ clientEvent: event }, 'client degradation')
    return reply.code(204).send()
  })

  // Internal: on the API's own port, not under /i/api (the edge doesn't route it).
  app.get('/metrics', async () => ({ clientEvents }))

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
    const failure = options.debugFailures ? debugFailure(req, query) : null
    if (failure === 'http') return reply.code(503).send({ error: 'debug failure' })
    if (failure === 'graphql') {
      const root = /\{\s*(\w+)/.exec(query)?.[1] ?? 'data'
      return { data: { [root]: null }, errors: [{ message: 'debug failure', path: [root] }] }
    }
    return executeGraphQL({ query, variables: request.variables }, authOf(req))
  })

  return app
}
