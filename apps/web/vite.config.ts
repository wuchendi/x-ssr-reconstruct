import babel from '@rolldown/plugin-babel'
import react from '@vitejs/plugin-react'
import relay from 'babel-plugin-relay'
import { defineConfig } from 'vite'

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
  plugins: [babel({ plugins: [[relay, { eagerEsModules: true }]] }), react()],
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
