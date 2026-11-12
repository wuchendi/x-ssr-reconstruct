import { Environment, Network, Observable, RecordSource, Store, type GraphQLResponse } from 'relay-runtime'
import { requestKey } from './key.ts'

export type FetchGraphQL = (query: string, variables: Record<string, unknown>) => Promise<GraphQLResponse>

// One environment per request: the store holds this visitor's data and must
// never be shared across requests.
//
// Every response the server receives is handed to `onResponse` as raw JSON
// text. It goes into the page once, verbatim; we do NOT serialize the Relay
// store (normalized records were 4-5x the size of the responses).
export function createServerEnvironment(fetchGraphQL: FetchGraphQL, onResponse: (key: string, json: string) => void) {
  const network = Network.create((params, variables) =>
    Observable.from(
      fetchGraphQL(params.text!, variables).then((response) => {
        onResponse(requestKey(params, variables), JSON.stringify(response))
        return response
      }),
    ),
  )
  return new Environment({ network, store: new Store(new RecordSource()), isServer: true })
}
