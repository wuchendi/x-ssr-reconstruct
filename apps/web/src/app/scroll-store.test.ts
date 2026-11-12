import { describe, expect, it } from 'vitest'
import { loadScrollPositions, saveScrollPositions } from './scroll-store.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  }
}

describe('scroll positions in sessionStorage', () => {
  it('round-trips positions', () => {
    const storage = memoryStorage()
    saveScrollPositions(
      storage,
      new Map([
        ['a', 120],
        ['b', 2146],
      ]),
    )
    expect(loadScrollPositions(storage)).toEqual(
      new Map([
        ['a', 120],
        ['b', 2146],
      ]),
    )
  })

  it('keeps only the most recent entries', () => {
    const storage = memoryStorage()
    const many = new Map(Array.from({ length: 80 }, (_, i) => [`k${i}`, i] as const))
    saveScrollPositions(storage, many)
    const loaded = loadScrollPositions(storage)
    expect(loaded.size).toBe(50)
    expect(loaded.has('k79')).toBe(true)
    expect(loaded.has('k0')).toBe(false)
  })

  it('starts empty when the stored value is missing or corrupt', () => {
    expect(loadScrollPositions(memoryStorage()).size).toBe(0)
    expect(loadScrollPositions(memoryStorage({ 'x-ssr:scroll': '{not json' })).size).toBe(0)
    expect(loadScrollPositions(memoryStorage({ 'x-ssr:scroll': '[["a","nope"]]' })).size).toBe(0)
  })

  it('never throws when storage is unavailable (private mode, quota)', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(loadScrollPositions(broken).size).toBe(0)
    expect(() => saveScrollPositions(broken, new Map([['a', 1]]))).not.toThrow()
  })
})
