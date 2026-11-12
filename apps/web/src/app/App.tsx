import type { ComponentType } from 'react'
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react'
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
// Unique within the tab's history; crypto.randomUUID() needs a secure context.
const newEntryKey = () => Math.random().toString(36).slice(2)
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

  // Scroll restoration: each history entry carries a key; positions are saved
  // per key when leaving an entry and restored after the target route commits.
  const scroll = useMemo(() => ({ positions: new Map<string, number>(), key: '', pending: null as number | null }), [])
  useEffect(() => {
    history.scrollRestoration = 'manual'
    scroll.key = history.state?.key ?? newEntryKey()
    history.replaceState({ ...history.state, key: scroll.key }, '')
  }, [scroll])

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
          // On popstate the entry has already changed, but scrollY still
          // belongs to the page being left: save it under that page's key.
          scroll.positions.set(scroll.key, window.scrollY)
          if (push) {
            scroll.key = newEntryKey()
            history.pushState({ key: scroll.key }, '', href)
            scroll.pending = 0
          } else {
            scroll.key = history.state?.key ?? newEntryKey()
            scroll.pending = scroll.positions.get(scroll.key) ?? 0
          }
          startTransition(() => setCurrent(state))
        })
        // The route's chunk failed to load (e.g. a deploy removed it): fall
        // back to a full page load instead of silently ignoring the click.
        .catch(() => {
          location.href = href
        })
    },
    [cache, prepare, scroll],
  )

  // After the target route commits (its content is in the DOM), scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per route commit; `current` is the trigger, not an input
  useLayoutEffect(() => {
    if (scroll.pending !== null) {
      window.scrollTo(0, scroll.pending)
      scroll.pending = null
    }
  }, [current, scroll])

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
