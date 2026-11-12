import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Mode, ServerConfig } from './index.ts'

// Vite in middleware mode: SSR modules are loaded fresh per request, and the
// browser gets HMR + React Fast Refresh over this same HTTP port.
export async function developmentMode(app: FastifyInstance, config: ServerConfig): Promise<Mode> {
  const { createServer } = await import('vite')
  const { default: middie } = await import('@fastify/middie')
  const vite = await createServer({
    root: fileURLToPath(config.root),
    appType: 'custom',
    // HMR websocket shares Fastify's HTTP server: one port for everything.
    server: { middlewareMode: true, hmr: { server: app.server } },
  })
  app.addHook('onClose', () => vite.close())
  await app.register(middie)
  app.use(vite.middlewares)

  // What Vite would inject into index.html (its client + the React Refresh
  // preamble), taken from Vite itself so plugin upgrades keep working.
  const injected = await vite.transformIndexHtml('/', '<html><head></head><body></body></html>')
  const imports = [...injected.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map(
    (m) => `import ${JSON.stringify(m[1])};`,
  )
  const inline = [...injected.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1])

  // The page's loader script points at this tiny module, which installs the
  // preamble before importing the real entry.
  app.get('/__dev/entry/:name', (req, reply) => {
    const name = (req.params as { name: string }).name.replace(/\.js$/, '')
    const src = Object.hasOwn(config.entries, name) ? config.entries[name] : undefined
    if (!src) return reply.code(404).send()
    reply.type('text/javascript').send([...imports, ...inline, `await import(${JSON.stringify(`/${src}`)})`].join('\n'))
  })

  return {
    async ssr() {
      return vite.ssrLoadModule(`/${config.ssrEntry}`)
    },
    fixStacktrace: (err) => vite.ssrFixStacktrace(err),
    // A <link> request makes Vite serve the CSS itself, so first paint is
    // styled in dev too; the JS import of the same file then handles HMR.
    assets: (entryName) => ({
      entry: `/__dev/entry/${entryName}.js`,
      preloads: [],
      css: (config.devCss ?? []).map((p) => `/${p}`),
    }),
  }
}
