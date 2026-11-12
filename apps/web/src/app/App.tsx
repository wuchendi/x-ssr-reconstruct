import type { ComponentType } from 'react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { RelayEnvironmentProvider } from 'react-relay'
import type { Environment } from 'relay-runtime'
import { ErrorBoundary } from '../components/ErrorBoundary.tsx'
import { IconSprite } from '../components/PostCard.tsx'
import { loadRoute } from '../router/load.ts'
import { PreloadCache } from '../router/preload-cache.ts'
import { matchRoute } from '../router/routes.ts'
import type { Audience, PageProps, Params, Refs, RouteDef } from '../router/types.ts'
import type { AppCtx } from './context.ts'
import { AppContext } from './context.ts'
import type { Assets } from './Document.tsx'
import { Document } from './Document.tsx'
import '../styles.css'

export type RouteState = { route: RouteDef; params: Params; refs: Refs; Page: ComponentType<PageProps>; href: string }

type Props = {
  env: Environment
  audience: Audience
  signedIn: boolean
  flags: Record<string, boolean>
  assets: Assets
  initial: RouteState
}

const PRELOAD_MAX = 20
const PRELOAD_TTL_MS = 30_000

export function App({ env, audience, signedIn, flags, assets, initial }: Props) {
  const [current, setCurrent] = useState(initial)
  const [, startTransition] = useTransition()
  const cache = useMemo(() => new PreloadCache<Promise<RouteState>>({ max: PRELOAD_MAX, ttlMs: PRELOAD_TTL_MS }), [])

  // Start the route's code AND data together. Called on hover/focus/press,
  // so by the time the click lands both are usually in flight or done.
  const prepare = useCallback(
    (href: string): Promise<RouteState> | null => {
      const hit = cache.get(href)
      if (hit) return hit
      const url = new URL(href, location.origin)
      const match = matchRoute(url.pathname, signedIn)
      if (!match) return null
      const refs = loadRoute(env, match.route, match.params)
      const state = match.route
        .page()
        .then((m) => ({ route: match.route, params: match.params, refs, Page: m.default, href }))
      cache.set(href, state, Object.values(refs))
      return state
    },
    [cache, env, signedIn],
  )

  const go = useCallback(
    (href: string, push: boolean) => {
      const prepared = prepare(href)
      // The navigation now owns the preload: the cache must not dispose it.
      const next = prepared && cache.take(href)
      // Path the new app doesn't own: in production the edge sends it to rweb.
      if (!next) {
        location.href = href
        return
      }
      next
        .then((state) => {
          if (push) history.pushState(null, '', href)
          startTransition(() => setCurrent(state))
          window.scrollTo(0, 0)
        })
        // The route's chunk failed to load (e.g. a deploy removed it): fall
        // back to a full page load instead of silently ignoring the click.
        .catch(() => {
          location.href = href
        })
    },
    [cache, prepare],
  )

  // After a route commits, protect its query refs and release the previous
  // route's (unless the new route reuses them).
  const committedRefs = useRef<Refs[string][]>([])
  useEffect(() => {
    const previous = committedRefs.current
    const next = Object.values(current.refs)
    committedRefs.current = next
    cache.protect(next)
    for (const r of previous) if (!next.includes(r)) r.dispose()
  }, [cache, current])

  useEffect(() => {
    const onPop = () => go(location.pathname + location.search, false)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [go])

  const ctx: AppCtx = useMemo(
    () => ({ audience, signedIn, flags, navigate: (h) => go(h, true), preload: (h) => void prepare(h) }),
    [audience, signedIn, flags, go, prepare],
  )

  const { Page, route, refs, params } = current
  return (
    <RelayEnvironmentProvider environment={env}>
      <AppContext value={ctx}>
        <Document route={route} refs={refs} params={params} assets={assets}>
          <Shell>
            <ErrorBoundary key={current.href}>
              <Suspense fallback={<p className="muted">Loading…</p>}>
                <Page refs={refs} params={params} />
              </Suspense>
            </ErrorBoundary>
          </Shell>
        </Document>
      </AppContext>
    </RelayEnvironmentProvider>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <IconSprite />
      <header className="topbar">
        <a href="/">𝕏-ish</a>
      </header>
      <main>{children}</main>
    </div>
  )
}
