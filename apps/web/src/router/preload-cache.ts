// Intent preloads (hover, focus, press) start a route's code and queries
// before the click. Each preloaded query ref retains its data in the Relay
// store until disposed, so the cache bounds how many it keeps and for how
// long, and disposes what it drops. A ref handed to the rendered route
// (take/protect) is never disposed here.
type Disposable = { dispose: () => void }
type Entry<T> = { value: T; refs: Disposable[]; at: number }

export class PreloadCache<T> {
  #entries = new Map<string, Entry<T>>()
  #protected = new Set<Disposable>()
  #max: number
  #ttlMs: number
  #now: () => number

  constructor({ max, ttlMs, now = Date.now }: { max: number; ttlMs: number; now?: () => number }) {
    this.#max = max
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (this.#now() - entry.at > this.#ttlMs) {
      this.#drop(key, entry)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, refs: Disposable[]) {
    const old = this.#entries.get(key)
    if (old) this.#drop(key, old)
    this.#entries.set(key, { value, refs, at: this.#now() })
    // Map iteration order is insertion order: the first entry is the oldest.
    for (const [k, e] of this.#entries) {
      if (this.#entries.size <= this.#max) break
      this.#drop(k, e)
    }
  }

  // Remove an entry without disposing it: the caller now owns its refs.
  take(key: string): T | undefined {
    const value = this.get(key)
    this.#entries.delete(key)
    return value
  }

  // Refs of the rendered route: never disposed by the cache.
  protect(refs: Disposable[]) {
    this.#protected = new Set(refs)
  }

  #drop(key: string, entry: Entry<T>) {
    this.#entries.delete(key)
    for (const r of entry.refs) if (!this.#protected.has(r)) r.dispose()
  }
}
