// Persisted queries: relay-compiler writes { id: query text } at codegen and
// strips the text from the client bundle. The browser sends only an id; the
// server runs only queries it knows. Arbitrary GraphQL from clients is refused.
import { readFileSync } from 'node:fs'

export type PersistedRequest = { id: string; variables: Record<string, unknown> }

// reload: re-read on every lookup (dev, where codegen rewrites the file).
export function loadPersistedQueries(file: URL, { reload }: { reload: boolean }) {
  const read = (): Record<string, string> => JSON.parse(readFileSync(file, 'utf8'))
  let cached: Record<string, string> | undefined
  return {
    get(id: string): string | undefined {
      if (reload || !cached) cached = read()
      const map = cached
      return Object.hasOwn(map, id) ? map[id] : undefined
    },
  }
}

export function parsePersistedRequest(body: unknown): PersistedRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { id, variables = {} } = body as { id?: unknown; variables?: unknown }
  if (typeof id !== 'string') return null
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return null
  return { id, variables: variables as Record<string, unknown> }
}
