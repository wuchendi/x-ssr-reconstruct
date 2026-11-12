import { describe, expect, it, vi } from 'vitest'
import { PreloadCache } from './preload-cache.ts'

type Ref = { name: string; dispose: () => void }
const ref = (name: string): Ref => ({ name, dispose: vi.fn() })

function setup(opts: { max?: number; ttlMs?: number } = {}) {
  let now = 0
  const cache = new PreloadCache<string>({ max: opts.max ?? 3, ttlMs: opts.ttlMs ?? 1000, now: () => now })
  return { cache, advance: (ms: number) => (now += ms) }
}

describe('PreloadCache', () => {
  it('returns a fresh entry until it expires', () => {
    const { cache, advance } = setup()
    const a = ref('a')
    cache.set('/a', 'state-a', [a])
    advance(999)
    expect(cache.get('/a')).toBe('state-a')
    advance(2)
    expect(cache.get('/a')).toBeUndefined()
  })

  it('disposes the query refs of an expired entry', () => {
    const { cache, advance } = setup()
    const a = ref('a')
    cache.set('/a', 'state-a', [a])
    advance(1001)
    cache.get('/a')
    expect(a.dispose).toHaveBeenCalledOnce()
  })

  it('evicts and disposes the oldest entry beyond the cap', () => {
    const { cache } = setup({ max: 2 })
    const [a, b, c] = [ref('a'), ref('b'), ref('c')]
    cache.set('/a', 'a', [a])
    cache.set('/b', 'b', [b])
    cache.set('/c', 'c', [c])
    expect(a.dispose).toHaveBeenCalledOnce()
    expect(b.dispose).not.toHaveBeenCalled()
    expect(cache.get('/a')).toBeUndefined()
    expect(cache.get('/c')).toBe('c')
  })

  it('hands ownership to the caller on take(): the refs are not disposed', () => {
    const { cache, advance } = setup({ max: 1 })
    const a = ref('a')
    cache.set('/a', 'a', [a])
    expect(cache.take('/a')).toBe('a')
    cache.set('/b', 'b', [ref('b')])
    advance(5000)
    cache.get('/b')
    expect(a.dispose).not.toHaveBeenCalled()
    expect(cache.get('/a')).toBeUndefined()
  })

  it('never disposes refs that are in use by the rendered route', () => {
    const { cache } = setup({ max: 1 })
    const shared = ref('shared')
    cache.set('/a', 'a', [shared])
    cache.protect([shared])
    cache.set('/b', 'b', [ref('b')])
    expect(shared.dispose).not.toHaveBeenCalled()
  })

  it('replaces an entry for the same key, disposing the old refs', () => {
    const { cache } = setup()
    const a1 = ref('a1')
    cache.set('/a', 'a1', [a1])
    cache.set('/a', 'a2', [ref('a2')])
    expect(a1.dispose).toHaveBeenCalledOnce()
    expect(cache.get('/a')).toBe('a2')
  })
})
