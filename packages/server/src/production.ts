import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { Mode, RouteAssets, ServerConfig } from './index.ts'

type Manifest = Record<string, { file: string; css?: string[]; imports?: string[] }>

// Built bundles: dist/client (Vite manifest + assets) and dist/server (SSR entry).
export async function productionMode(app: FastifyInstance, config: ServerConfig): Promise<Mode> {
  const dist = new URL('dist/', config.root)
  const manifest: Manifest = JSON.parse(readFileSync(new URL('client/.vite/manifest.json', dist), 'utf8'))
  const ssrFile = `${basename(config.ssrEntry).replace(/\.[cm]?[jt]sx?$/, '')}.js`
  const ssrModule = import(new URL(`server/${ssrFile}`, dist).href)

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('client/assets/', dist)),
    prefix: '/assets/',
    immutable: true,
    maxAge: '1y',
    preCompressed: true,
  })

  const collect = (key: string, out: { js: Set<string>; css: Set<string> }) => {
    const chunk = manifest[key]
    if (!chunk || out.js.has(`/${chunk.file}`)) return
    out.js.add(`/${chunk.file}`)
    for (const c of chunk.css ?? []) out.css.add(`/${c}`)
    for (const imp of chunk.imports ?? []) collect(imp, out)
  }

  const cache = new Map<string, RouteAssets>()
  return {
    ssr: () => ssrModule,
    assets(entryName, modules) {
      const cacheKey = `${entryName}|${modules.join(',')}`
      const hit = cache.get(cacheKey)
      if (hit) return hit
      const entrySrc = config.entries[entryName]
      if (!entrySrc || !manifest[entrySrc]) throw new Error(`unknown client entry: ${entryName}`)
      const out = { js: new Set<string>(), css: new Set<string>() }
      collect(entrySrc, out)
      for (const m of modules) collect(m, out)
      const entry = `/${manifest[entrySrc].file}`
      // Startup chunks plus the chunks of the modules the server rendered.
      const result = { entry, preloads: [...out.js].filter((f) => f !== entry), css: [...out.css] }
      cache.set(cacheKey, result)
      return result
    },
  }
}
