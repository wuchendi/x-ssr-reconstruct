// The web server's view of the API tier: guest tokens, feature flags and
// persisted GraphQL over HTTP. Timeouts abort the request itself. As with any
// timer, a saturated event loop can fire them late or early (see the post's
// "more rendering workers").
import type { GraphQLResponse } from 'relay-runtime'

// debugFail: forwarded x-debug-fail header (test harness, DEBUG_FAILURES=1 only).
export type Auth = { guestToken?: string; userToken?: string; debugFail?: string }

export function createApiClient(baseUrl: string, timeoutMs: number) {
  // signal: the caller's cancellation (client disconnected, Relay disposed
  // the query), combined with the timeout.
  async function call<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    const res = await fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.any(signals) })
    if (!res.ok) throw Object.assign(new Error(`API ${path} answered ${res.status}`), { statusCode: 502 })
    return (await res.json()) as T
  }

  return {
    async guestToken(signal?: AbortSignal) {
      const body = await call<{ guest_token: string }>('/i/api/1.1/guest/activate.json', { method: 'POST' }, signal)
      return body.guest_token
    },
    flags: (country: string, signal?: AbortSignal) =>
      call<Record<string, boolean>>(`/i/api/flags?country=${encodeURIComponent(country)}`, {}, signal),
    graphql(id: string, variables: Record<string, unknown>, auth: Auth, signal?: AbortSignal) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (auth.guestToken) headers['x-guest-token'] = auth.guestToken
      if (auth.userToken) headers.cookie = `auth_token=${encodeURIComponent(auth.userToken)}`
      if (auth.debugFail) headers['x-debug-fail'] = auth.debugFail
      return call<GraphQLResponse>(
        '/i/api/graphql',
        { method: 'POST', headers, body: JSON.stringify({ id, variables }) },
        signal,
      )
    },
  }
}
