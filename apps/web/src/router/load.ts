import type { PreloadedQuery } from 'react-relay'
import { loadQuery } from 'react-relay'
import type { Environment, OperationType } from 'relay-runtime'
import type { Params, Refs, RouteDef } from './types.ts'

// The same function runs on the server (to start fetches before rendering) and
// in the browser (at hydration, where the network replays the server's
// responses, and on intent-to-navigate preloads).
export function loadRoute(env: Environment, route: RouteDef, params: Params, opts: { headOnly?: boolean } = {}): Refs {
  const refs: Refs = {}
  const { primary, body } = route.loader
  if (primary)
    refs.primary = loadQuery(env, primary.query, primary.variables(params), { fetchPolicy: 'store-or-network' })
  if (body && !opts.headOnly) {
    for (const [name, spec] of Object.entries(body)) {
      refs[name] = loadQuery(env, spec.query, spec.variables(params), { fetchPolicy: 'store-or-network' })
    }
  }
  return refs
}

// Resolve once the primary query's network request (if any) settles.
export function primarySettled(ref: PreloadedQuery<OperationType> | undefined): Promise<unknown> {
  const source = (ref as { source?: { toPromise(): Promise<unknown> } } | undefined)?.source
  return source ? source.toPromise() : Promise.resolve()
}
