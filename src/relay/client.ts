import { Environment, Network, Observable, RecordSource, Store, type GraphQLResponse } from 'relay-runtime'
import { requestKey } from './key.ts'

// Registry installed by an inline <script> in <head> (see Document). The
// server streams each response as
//   <script type="application/json" data-rr="KEY">JSON</script><script>__rr.p()</script>
// and __rr.p() moves the JSON *text* into this map. Parsing is deferred to
// replay time.
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

function take(key: string): GraphQLResponse | undefined {
  const text = window.__rr.m.get(key)
  if (text === undefined) return undefined
  window.__rr.m.delete(key)
  return JSON.parse(text)
}

async function fetchFromApi(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
  const res = await fetch('/i/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
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

  const network = Network.create((params, variables) =>
    Observable.create<GraphQLResponse>((sink) => {
      const key = requestKey(params, variables)
      const fromNetwork = () =>
        fetchFromApi(params.text!, variables).then(
          (r) => (sink.next(r), sink.complete()),
          (e) => sink.error(e),
        )
      const tryReplay = () => {
        const replayed = take(key)
        if (replayed === undefined) return false
        sink.next(replayed)
        sink.complete()
        return true
      }

      if (tryReplay()) return
      if (rr.done) {
        fromNetwork()
        return
      }
      // The server is still fetching this one; its response is further down
      // the stream. Wait for it instead of asking the API a second time.
      const waiters = rr.w.get(key) ?? []
      waiters.push(() => tryReplay() || fromNetwork())
      rr.w.set(key, waiters)
    }),
  )
  return new Environment({ network, store: new Store(new RecordSource()) })
}
