import { listen } from '@x-ssr/server'
import { create } from './app.ts'

// nsl passes HOST=127.0.0.1 in dev so the app is reachable only through the
// proxy; without it (CI, containers) listen on all interfaces.
await listen(await create(), { port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' })
