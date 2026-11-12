// Relay store configuration, in one place.
import { RecordSource, Store } from 'relay-runtime'

// Browser: queries released by navigation stay in this buffer, so going back
// renders from the store without a refetch; older ones are collected.
export const RELEASE_BUFFER_SIZE = 10
// Browser: after this, cached data is stale and store-or-network refetches.
export const QUERY_CACHE_TTL_MS = 5 * 60_000

export function createClientStore() {
  return new Store(new RecordSource(), {
    gcReleaseBufferSize: RELEASE_BUFFER_SIZE,
    queryCacheExpirationTime: QUERY_CACHE_TTL_MS,
  })
}

// Server: one store per request, dropped with it. Nothing to keep around.
export function createServerStore() {
  return new Store(new RecordSource(), { gcReleaseBufferSize: 0 })
}
