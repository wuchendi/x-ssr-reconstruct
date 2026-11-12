// File-based route tree:
//   routes/_index/              -> /
//   routes/home/                -> /home
//   routes/[screenName]/        -> /:screenName
//   routes/[screenName]/status/[id]/ -> /:screenName/status/:id
// Loaders are eager (tiny: query artifacts + head()). Pages are lazy chunks.
// scripts/ngroutes.ts derives the same list for the edge.
import { pages } from './page-chunks.ts'
import type { RouteDef, RouteLoader } from './types.ts'

const loaders = import.meta.glob<{ default: RouteLoader }>('../routes/**/loader.ts', { eager: true })

export function dirToPattern(dir: string): string {
  const segs = dir.split('/').filter((s) => s && s !== '_index')
  return `/${segs.map((s) => (s.startsWith('[') ? `:${s.slice(1, -1)}` : s)).join('/')}`
}

export function patternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const body = pattern
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? (paramNames.push(s.slice(1)), '([^/]+)') : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return { regex: new RegExp(`^/${body}/?$`, 'i'), paramNames }
}

// Static segments beat dynamic ones: /home must not match /:screenName.
const score = (p: string) => p.split('/').reduce((n, s) => n + (s.startsWith(':') ? 1 : 10), 0)

export const routes: RouteDef[] = Object.entries(loaders)
  .map(([file, mod]) => {
    const dir = file.replace('../routes/', '').replace(/\/?loader\.ts$/, '')
    const pattern = dirToPattern(dir)
    const pageFile = file.replace(/loader\.ts$/, 'page.tsx')
    return { id: dir || '_index', pattern, ...patternToRegex(pattern), loader: mod.default, page: pages[pageFile] }
  })
  .sort((a, b) => score(b.pattern) - score(a.pattern))

export function matchRoute(pathname: string, signedIn: boolean) {
  for (const route of routes) {
    if (route.loader.signedInOnly && !signedIn) continue
    const m = route.regex.exec(pathname)
    if (!m) continue
    const params = Object.fromEntries(route.paramNames.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
    return { route, params }
  }
  return null
}
