// @x-ssr/server: one Fastify app assembled from configuration, the analogue of
// X's internal @x-clients/server ("security headers, cookies, metrics,
// streaming rendering, and graceful shutdown"). Nothing in here knows about a
// particular app's routes, audiences or upstreams.
import type { Readable } from 'node:stream'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { developmentMode } from './development.ts'
import { productionMode } from './production.ts'

export { parseCookies, withTimeout } from './util.ts'
export type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export type RouteAssets = { entry: string; preloads: string[]; css: string[] }

export type ServerConfig = {
  // App root: holds the Vite config (dev) and dist/ (production).
  root: URL
  // SSR entry, relative to root (e.g. "src/entry-server.tsx").
  ssrEntry: string
  // Client entry points by name, relative to root.
  entries: Record<string, string>
  // Stylesheets linked in dev, relative to root (production reads the manifest).
  devCss?: string[]
  dev?: boolean
  logLevel?: string
}

export type Mode = {
  ssr(): Promise<unknown>
  assets(entryName: string, modules: string[]): RouteAssets
  fixStacktrace?(err: Error): void
}

export type SsrServer = {
  app: FastifyInstance
  dev: boolean
  // The SSR module: fresh per call in dev, loaded once in production.
  ssr<T>(): Promise<T>
  // Entry script, chunk preloads and stylesheets for a client entry plus the
  // source modules the server rendered (e.g. the matched route's page).
  assets(entryName: string, modules?: string[]): RouteAssets
  // Count an event; GET /metrics returns the counters.
  count(name: string): void
  // Send a rendered HTML stream with timing information.
  sendHtml(reply: FastifyReply, html: { status: number; body: Readable; timing?: Record<string, number> }): FastifyReply
  // Map an SSR error's stack trace back to source (dev only).
  fixStacktrace(err: unknown): void
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
}

export async function createServer(config: ServerConfig): Promise<SsrServer> {
  const dev = config.dev ?? process.env.NODE_ENV === 'development'
  const app = Fastify({ logger: { level: config.logLevel ?? process.env.LOG_LEVEL ?? 'info' }, return503OnClosing: true })

  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v)
  })

  const counters: Record<string, number> = {}
  app.get('/metrics', async () => counters)

  const mode = dev ? await developmentMode(app, config) : await productionMode(app, config)

  return {
    app,
    dev,
    async ssr<T>() {
      return (await mode.ssr()) as T
    },
    assets: (entryName, modules = []) => mode.assets(entryName, modules),
    count(name) {
      counters[name] = (counters[name] ?? 0) + 1
    },
    sendHtml(reply, { status, body, timing }) {
      reply.code(status).type('text/html; charset=utf-8')
      if (timing) {
        reply.header(
          'server-timing',
          Object.entries(timing)
            .map(([k, ms]) => `${k};dur=${ms.toFixed(1)}`)
            .join(', '),
        )
      }
      return reply.send(body)
    },
    fixStacktrace(err) {
      if (err instanceof Error) mode.fixStacktrace?.(err)
    },
  }
}

// Listen and shut down gracefully: stop accepting, let in-flight streams finish.
export async function listen(app: FastifyInstance, { port, host = '0.0.0.0' }: { port: number; host?: string }) {
  await app.listen({ port, host })
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void app.close().then(() => process.exit(0)))
  }
}
