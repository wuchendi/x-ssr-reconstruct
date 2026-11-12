// "ngroutes": discover the routes in the file-based route tree and publish them
// to the edge on every deploy. The edge sends a path to the new app only if it
// matches one of these (and the feature switch says this visitor is in);
// everything else goes to rweb.
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const base = new URL('../src/routes/', import.meta.url).pathname
const dirs: string[] = []
;(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (!statSync(full).isDirectory() || name === '__generated__') continue
    if (readdirSync(full).includes('loader.ts')) dirs.push(relative(base, full))
    walk(full)
  }
})(base)

const toPattern = (dir: string) =>
  `/${dir
    .split('/')
    .filter((s) => s && s !== '_index')
    .map((s) => (s.startsWith('[') ? `:${s.slice(1, -1)}` : s))
    .join('/')}`

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), routes: dirs.map(toPattern).sort() }, null, 2))
