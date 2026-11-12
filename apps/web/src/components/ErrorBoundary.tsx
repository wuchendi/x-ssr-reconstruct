import type { ReactNode } from 'react'
import { Component } from 'react'

// Without a boundary, a render error unmounts the whole hydrated document
// (hydrateRoot(document)) and leaves a blank page. Server errors inside a
// Suspense boundary are re-thrown on the client and land here as well.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <section className="profile" role="alert">
        <h1>Something went wrong</h1>
        <p className="muted">This part of the page failed to load.</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </section>
    )
  }
}
