import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import babel from '@rolldown/plugin-babel'
import react from '@vitejs/plugin-react'
import relay from 'babel-plugin-relay'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

// Dev only: rerun relay-compiler when a file with a graphql tag changes.
// Relay's own --watch needs watchman; without this, an edited query keeps
// using its stale artifact until someone remembers `pnpm codegen`.
function relayCodegenOnChange(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const compiler = fileURLToPath(new URL('node_modules/.bin/relay-compiler', import.meta.url))
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  return {
    name: 'x-ssr:relay-codegen',
    apply: 'serve',
    configureServer(server) {
      const run = () => {
        if (running) {
          again = true
          return
        }
        running = true
        const child = spawn(compiler, [], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d) => {
          stderr += d
        })
        child.on('exit', (code) => {
          running = false
          if (code === 0) server.config.logger.info('relay-compiler: artifacts updated', { timestamp: true })
          else server.config.logger.error(`relay-compiler failed:\n${stderr}`, { timestamp: true })
          if (again) {
            again = false
            run()
          }
        })
      }
      const onFile = (file: string) => {
        if (!/\.(ts|tsx)$/.test(file) || file.includes('__generated__') || !file.startsWith(`${root}src/`)) return
        try {
          if (!readFileSync(file, 'utf8').includes('graphql`')) return
        } catch {
          return
        }
        clearTimeout(timer)
        timer = setTimeout(run, 150)
      }
      server.watcher.on('change', onFile)
      server.watcher.on('add', onFile)
    },
  }
}

type ModuleInfoLike = { isEntry: boolean; importers: readonly string[] }
type Ctx = { getModuleInfo(id: string): ModuleInfoLike | null }

// "Fewer files at startup": a page can't hydrate until every file in its
// entry's *static* import graph has arrived. Instead of Rolldown's default
// (hundreds of tiny chunks -> several round trips at ~100 concurrent HTTP/2
// streams), pack every module some entry loads at startup into three chunks:
//   startup-deps  - node_modules, changes rarely
//   startup-app   - our own startup code
//   startup-names - the module that names lazily loaded chunks (route table);
//                   its content changes on almost every deploy, so it is kept
//                   apart to leave the other two cacheable.
// Lazily loaded modules (route pages) keep default chunking.
const reachable = new Map<string, boolean>()
function loadedAtStartup(id: string, ctx: Ctx, seen = new Set<string>()): boolean {
  const cached = reachable.get(id)
  if (cached !== undefined) return cached
  if (seen.has(id)) return false
  seen.add(id)
  const info = ctx.getModuleInfo(id)
  const result = !!info && (info.isEntry || info.importers.some((imp) => loadedAtStartup(imp, ctx, seen)))
  reachable.set(id, result)
  return result
}
// Entry modules themselves must stay in their entry chunks. Pulled into a
// shared group, every entry's top-level code would run in every entry: here,
// both boot(false) and boot(true) would hydrate the same document.
const startupNonEntry = (id: string, ctx: Ctx) => loadedAtStartup(id, ctx) && !ctx.getModuleInfo(id)?.isEntry

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [babel({ plugins: [[relay, { eagerEsModules: true }]] }), react(), relayCodegenOnChange()],
  build: isSsrBuild
    ? { outDir: 'dist/server', emptyOutDir: true }
    : {
        outDir: 'dist/client',
        emptyOutDir: true,
        manifest: true,
        rolldownOptions: {
          // Logged-out and signed-in visitors get separate entry points.
          input: { 'logged-out': 'src/entries/logged-out.tsx', 'signed-in': 'src/entries/signed-in.tsx' },
          output: {
            codeSplitting: {
              // Only the modules each group names; don't drag their imports in.
              includeDependenciesRecursively: false,
              groups: [
                { name: 'startup-names', test: /[\\/]src[\\/]router[\\/]page-chunks\.ts$/, priority: 30 },
                {
                  debugName: 'startup-deps',
                  name: (id: string, ctx: Ctx) => (startupNonEntry(id, ctx) ? 'startup-deps' : null),
                  test: /[\\/]node_modules[\\/]/,
                  priority: 20,
                },
                {
                  debugName: 'startup-app',
                  name: (id: string, ctx: Ctx) =>
                    startupNonEntry(id, ctx) && !/\.css$/.test(id) ? 'startup-app' : null,
                  test: /[\\/]src[\\/]/,
                  priority: 10,
                },
              ],
            },
          },
        },
      },
}))
