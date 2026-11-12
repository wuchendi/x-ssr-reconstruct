import type { GraphQLResponse } from 'relay-runtime'
import { Environment, Network, Observable } from 'relay-runtime'
import { requestKey } from './key.ts'
import { createServerStore } from './store.ts'

// Persisted queries: operations travel by id; the server resolves the text.
// The signal aborts the upstream call when Relay cancels the request.
export type FetchGraphQL = (
  id: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<GraphQLResponse>

// One environment per request: the store holds this visitor's data and must
// never be shared across requests.
//
// Every response the server receives is handed to `onResponse` as raw JSON
// text. It goes into the page once, verbatim; we do NOT serialize the Relay
// store (normalized records were 4-5x the size of the responses).
export function createServerEnvironment(fetchGraphQL: FetchGraphQL, onResponse: (key: string, json: string) => void) {
  const network = Network.create((params, variables) =>
    Observable.create<GraphQLResponse>((sink) => {
      const cancel = new AbortController()
      fetchGraphQL(params.id!, variables, cancel.signal).then(
        (response) => {
          onResponse(requestKey(params, variables), JSON.stringify(response))
          sink.next(response)
          sink.complete()
        },
        (err) => {
          if (!cancel.signal.aborted) sink.error(err)
        },
      )
      return () => cancel.abort()
    }),
  )
  return new Environment({ network, store: createServerStore(), isServer: true })
}
