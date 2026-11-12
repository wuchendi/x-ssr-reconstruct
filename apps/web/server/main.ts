import { listen } from '@x-ssr/server'
import { create } from './app.ts'

await listen(await create(), { port: Number(process.env.PORT ?? 3000) })
