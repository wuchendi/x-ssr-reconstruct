// The browser's Relay fetch function. A response the server already fetched
// is replayed from the stream; one still on its way is waited for; anything
// else goes to the API. Unsubscribing (Relay does that when a PreloadedQuery
// is disposed) really cancels: the waiter is removed and the fetch aborted.
import type { GraphQLResponse, RequestParameters, Variables } from 'relay-runtime'
import { Observable } from 'relay-runtime'
import { requestKey } from './key.ts'
import { checkResponse } from './response-policy.ts'

export type ReplaySource = {
  // Remove and return the streamed JSON text for a request key.
  take(key: string): string | undefined
  // True once the document (and so the stream) has finished.
  readonly ended: boolean
  // Call onChange when the key's response arrives or the stream ends.
  // Returns an unsubscribe function.
  wait(key: string, onChange: () => void): () => void
}

export type ApiCall = (
  id: string,
  operationName: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<GraphQLResponse>

// Always an Observable (narrower than Relay's FetchFunction, and assignable to it).
export type ReplayFetch = (params: RequestParameters, variables: Variables) => Observable<GraphQLResponse>

export function createReplayFetch(opts: { source: ReplaySource; api: ApiCall; timeoutMs: number }): ReplayFetch {
  const { source, api, timeoutMs } = opts
  return (params, variables) =>
    Observable.create<GraphQLResponse>((sink) => {
      const key = requestKey(params, variables)
      let stopWaiting: (() => void) | undefined
      let cancel: AbortController | undefined

      const deliver = (response: GraphQLResponse) => {
        try {
          sink.next(
            checkResponse(response, params.name, (op, errors) => console.warn(`[relay] ${op}: partial`, errors)),
          )
          sink.complete()
        } catch (err) {
          sink.error(err as Error)
        }
      }
      const replay = () => {
        const text = source.take(key)
        if (text === undefined) return false
        deliver(JSON.parse(text))
        return true
      }
      const fromApi = () => {
        cancel = new AbortController()
        const timeout = AbortSignal.timeout(timeoutMs)
        api(params.id!, params.name, variables, AbortSignal.any([cancel.signal, timeout])).then(deliver, (err) => {
          // Cancelled by the subscriber: nobody is listening any more.
          if (cancel?.signal.aborted) return
          sink.error(timeout.aborted ? new Error(`${params.name} timed out after ${timeoutMs}ms`) : err)
        })
      }

      if (!replay()) {
        if (source.ended) {
          fromApi()
        } else {
          stopWaiting = source.wait(key, () => {
            stopWaiting?.()
            stopWaiting = undefined
            if (!replay()) fromApi()
          })
        }
      }

      return () => {
        stopWaiting?.()
        cancel?.abort()
      }
    })
}
