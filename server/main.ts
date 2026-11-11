import { create } from './app.ts'

const app = await create()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

// Graceful shutdown: stop accepting, let in-flight streams finish.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => void app.close().then(() => process.exit(0)))
}
