// Checks the client build output. Run after `pnpm build`.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dist = new URL('../dist/client/', import.meta.url)
const manifestPath = new URL('.vite/manifest.json', dist)
type Chunk = { file: string; imports?: string[]; isEntry?: boolean }

describe.skipIf(!existsSync(manifestPath))('client bundle', () => {
  const manifest: Record<string, Chunk> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const keyOf = (prefix: string) => Object.keys(manifest).find((k) => k.startsWith(`_${prefix}-`))!
  const read = (file: string) => readFileSync(new URL(file, dist), 'utf8')

  // Regression: entry modules captured into a shared group made every entry
  // run both boot(false) and boot(true) on the same document.
  it('each entry runs only its own boot()', () => {
    const loggedOut = read(manifest['src/entries/logged-out.tsx'].file)
    const signedIn = read(manifest['src/entries/signed-in.tsx'].file)
    expect(loggedOut).toMatch(/\(!1\)/)
    expect(loggedOut).not.toMatch(/\(!0\)/)
    expect(signedIn).toMatch(/\(!0\)/)
    expect(signedIn).not.toMatch(/\(!1\)/)
  })

  // Regression: the chunk naming lazy pages imported app code, which imported
  // it back: a startup chunk cycle that crashed at runtime.
  it('startup-names does not import app code', () => {
    const names = manifest[keyOf('startup-names')]
    expect(names.imports ?? []).not.toContain(keyOf('startup-app'))
  })

  it('packs startup code into a handful of files', () => {
    const seen = new Set<string>()
    const walk = (key: string) => {
      if (seen.has(key)) return
      seen.add(key)
      for (const i of manifest[key].imports ?? []) walk(i)
    }
    walk('src/entries/logged-out.tsx')
    expect(seen.size).toBeLessThanOrEqual(8)
  })
})
