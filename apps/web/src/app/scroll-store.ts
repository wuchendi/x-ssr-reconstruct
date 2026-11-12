// Scroll positions per history entry, kept in sessionStorage so they survive
// a reload or a trip to another site and back (the history entry's key does).
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const KEY = 'x-ssr:scroll'
const MAX_ENTRIES = 50

export function loadScrollPositions(storage: Storage): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return new Map()
    const valid = parsed.filter(
      (e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]),
    )
    return new Map(valid)
  } catch {
    return new Map()
  }
}

// Maps keep insertion order: the last entries are the most recent.
export function saveScrollPositions(storage: Storage, positions: Map<string, number>) {
  try {
    storage.setItem(KEY, JSON.stringify([...positions].slice(-MAX_ENTRIES)))
  } catch {
    // Storage full or unavailable (private mode): restoration is best effort.
  }
}
