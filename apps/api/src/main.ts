import { create } from './app.ts'

const app = await create({
  persistedQueries: process.env.PERSISTED_QUERIES
    ? new URL(process.env.PERSISTED_QUERIES, `file://${process.cwd()}/`)
    : // In a real deployment the web app's build registers its operations with
      // the API; here the API reads the file relay-compiler wrote.
      new URL('../../web/src/__generated__/persisted-queries.json', import.meta.url),
  reload: process.env.NODE_ENV === 'development',
  debugFailures: process.env.DEBUG_FAILURES === '1',
})
const port = Number(process.env.PORT ?? 3302)
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' })

// Graceful shutdown: stop accepting, let in-flight requests finish.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => void app.close().then(() => process.exit(0)))
}
