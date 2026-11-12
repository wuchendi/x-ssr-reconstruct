import type { GraphQLResponse } from 'relay-runtime'
import { Environment, Network } from 'relay-runtime'
import type { ApiCall, ReplaySource } from './replay-network.ts'
import { createReplayFetch } from './replay-network.ts'
import { createClientStore } from './store.ts'

// Registry installed by an inline <script> in <head> (see Document). The
// server streams each response as
//   <script type="application/json" data-rr="KEY">JSON</script><script>__rr.p()</script>
// and __rr.p() moves the JSON *text* into this map and calls the key's
// waiters. Parsing is deferred to replay time.
type ReplayRegistry = {
  m: Map<string, string>
  w: Map<string, Array<() => void>>
  done: boolean
}
declare global {
  interface Window {
    __rr: ReplayRegistry
  }
}

// Responses nothing has read yet stay available this long after the stream
// ends, so a tab or dialog opened right after still finds them.
const HOLD_AFTER_STREAM_END_MS = 30_000
// Browser-side GraphQL calls (after the stream) give up after this.
const CLIENT_TIMEOUT_MS = 10_000

// Persisted queries: only the operation id is sent, never query text. The
// operation name is for logs and tooling; the server ignores it.
const fetchFromApi: ApiCall = async (id, operationName, variables, signal) => {
  const res = await fetch('/i/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, operationName, variables }),
    signal,
  })
  if (!res.ok) throw new Error(`${operationName} failed: HTTP ${res.status}`)
  return (await res.json()) as GraphQLResponse
}

function replaySource(rr: ReplayRegistry): ReplaySource {
  return {
    take(key) {
      const text = rr.m.get(key)
      rr.m.delete(key)
      return text
    },
    get ended() {
      return rr.done
    },
    wait(key, onChange) {
      const waiters = rr.w.get(key) ?? []
      waiters.push(onChange)
      rr.w.set(key, waiters)
      return () => {
        const list = rr.w.get(key)
        if (list)
          rr.w.set(
            key,
            list.filter((fn) => fn !== onChange),
          )
      }
    },
  }
}

export function createClientEnvironment() {
  const rr = window.__rr
  const onStreamEnd = () => {
    rr.done = true
    // Anyone still waiting gets nothing from the stream: fall back to the API.
    for (const waiters of rr.w.values()) for (const fn of waiters) fn()
    rr.w.clear()
    setTimeout(() => rr.m.clear(), HOLD_AFTER_STREAM_END_MS)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onStreamEnd, { once: true })
  else onStreamEnd()

  const network = Network.create(
    createReplayFetch({ source: replaySource(rr), api: fetchFromApi, timeoutMs: CLIENT_TIMEOUT_MS }),
  )
  return new Environment({ network, store: createClientStore() })
}
