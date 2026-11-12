import type { RequestParameters, Variables } from 'relay-runtime'

// Server and browser must derive the same key for the same operation, or the
// browser can't find the response the server already fetched.
export function requestKey(params: RequestParameters, variables: Variables): string {
  return `${params.name}:${stableStringify(variables)}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}
