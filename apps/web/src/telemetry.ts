// Degradation only the browser sees, reported to the API tier
// (/i/api/client-events): sendBeacon still delivers while the page unloads.
// Reporting must never break the page, so failures are swallowed.
export type ClientEvent = {
  type: 'recoverable-error' | 'section-error' | 'page-error' | 'navigation-failed'
  detail?: string
}

export function reportClientEvent(event: ClientEvent) {
  try {
    const body = JSON.stringify({
      type: event.type,
      route: location.pathname.slice(0, 200),
      detail: event.detail?.slice(0, 300),
    })
    navigator.sendBeacon('/i/api/client-events', new Blob([body], { type: 'application/json' }))
  } catch {
    // No beacon support, or the browser refused to queue it.
  }
}
