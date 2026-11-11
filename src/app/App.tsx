import { Suspense, useCallback, useEffect, useMemo, useState, useTransition, type ComponentType } from 'react'
import { RelayEnvironmentProvider } from 'react-relay'
import type { Environment } from 'relay-runtime'
import { loadRoute } from '../router/load.ts'
import { matchRoute } from '../router/routes.ts'
import type { Audience, PageProps, Params, Refs, RouteDef } from '../router/types.ts'
import { AppContext, type AppCtx } from './context.ts'
import { Document, type Assets } from './Document.tsx'
import { IconSprite } from '../components/PostCard.tsx'
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

type Preloaded = { state: Promise<RouteState>; at: number }
const PRELOAD_TTL_MS = 30_000

export function App({ env, audience, signedIn, flags, assets, initial }: Props) {
  const [current, setCurrent] = useState(initial)
  const [, startTransition] = useTransition()
  const cache = useMemo(() => new Map<string, Preloaded>(), [])

  // Start the route's code AND data together. Called on hover/focus/press,
  // so by the time the click lands both are usually in flight or done.
  const prepare = useCallback(
    (href: string): Promise<RouteState> | null => {
      const hit = cache.get(href)
      if (hit && Date.now() - hit.at < PRELOAD_TTL_MS) return hit.state
      const url = new URL(href, location.origin)
      const match = matchRoute(url.pathname, signedIn)
      if (!match) return null
      const refs = loadRoute(env, match.route, match.params)
      const state = match.route
        .page()
        .then((m) => ({ route: match.route, params: match.params, refs, Page: m.default, href }))
      cache.set(href, { state, at: Date.now() })
      return state
    },
    [cache, env, signedIn],
  )

  const go = useCallback(
    (href: string, push: boolean) => {
      const next = prepare(href)
      // Path the new app doesn't own: in production the edge sends it to rweb.
      if (!next) return void (location.href = href)
      next.then((state) => {
        if (push) history.pushState(null, '', href)
        startTransition(() => setCurrent(state))
        window.scrollTo(0, 0)
      })
    },
    [prepare],
  )

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
            <Suspense fallback={<p className="muted">Loading…</p>}>
              <Page refs={refs} params={params} />
            </Suspense>
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
