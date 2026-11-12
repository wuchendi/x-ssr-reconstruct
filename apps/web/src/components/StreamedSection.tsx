import type { ReactNode } from 'react'
import { Component, Suspense, useCallback, useEffect, useState } from 'react'
import type { PreloadedQuery } from 'react-relay'
import { loadQuery } from 'react-relay'
import type { ConcreteRequest, OperationType } from 'relay-runtime'
import { reportClientEvent } from '../telemetry.ts'

type Ref = PreloadedQuery<OperationType>

// A streamed part of a page (timeline, replies) that fails on its own: the
// rest of the page stays, and the section offers a retry.
//
// How a failure gets here: if the section's query fails on the server, React
// hands the boundary to the browser (a recoverable error); the browser's
// network then asks the API itself. If that fails too, the error lands in
// SectionBoundary.
export function StreamedSection(props: {
  query: ConcreteRequest
  queryRef: Ref
  what: string
  fallback: ReactNode
  children: (queryRef: Ref) => ReactNode
}) {
  const { queryRef, retry } = useRetryableQuery(props.query, props.queryRef)
  return (
    <SectionBoundary what={props.what} onRetry={retry}>
      <Suspense fallback={props.fallback}>{props.children(queryRef)}</Suspense>
    </SectionBoundary>
  )
}

// The section's current ref, and retry(): load it again from the network.
// Refs created by retries are released here; the route owns the first one.
export function useRetryableQuery(query: ConcreteRequest, initial: Ref) {
  const [state, setState] = useState({ base: initial, ref: initial })
  // A new route brings a new initial ref: start over.
  if (state.base !== initial) setState({ base: initial, ref: initial })

  const retry = useCallback(() => {
    const ref = loadQuery<OperationType>(initial.environment, query, initial.variables, { fetchPolicy: 'network-only' })
    setState({ base: initial, ref })
  }, [query, initial])

  useEffect(() => {
    const { ref, base } = state
    return () => {
      if (ref !== base) ref.dispose()
    }
  }, [state])

  return { queryRef: state.ref, retry }
}

class SectionBoundary extends Component<
  { what: string; onRetry: () => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(error)
    reportClientEvent({ type: 'section-error', detail: `${this.props.what}: ${error.message}` })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="post section-error" role="alert">
        <p>Couldn't load {this.props.what}.</p>
        <button
          type="button"
          onClick={() => {
            this.setState({ error: null })
            this.props.onRetry()
          }}
        >
          Retry
        </button>
      </div>
    )
  }
}
