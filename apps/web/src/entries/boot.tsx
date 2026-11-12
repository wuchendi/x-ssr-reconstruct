import { hydrateRoot } from 'react-dom/client'
import { App } from '../app/App.tsx'
import { createClientEnvironment } from '../relay/client.ts'
import { loadRoute } from '../router/load.ts'
import { matchRoute } from '../router/routes.ts'
import { reportClientEvent } from '../telemetry.ts'

export async function boot(signedIn: boolean) {
  const env = createClientEnvironment()
  const match = matchRoute(location.pathname, signedIn)
  if (!match) return
  const { route, params } = match

  // Same loader as the server. For server-rendered routes the network replays
  // the streamed responses: no GraphQL request leaves the browser.
  const refs = loadRoute(env, route, params)
  const { default: Page } = await route.page()

  const data = JSON.parse(document.getElementById('app-data')!.textContent!)
  const assets = {
    css: [...document.querySelectorAll<HTMLLinkElement>('head link[rel=stylesheet]')].map(
      (l) => l.getAttribute('href')!,
    ),
    loaderScript: document.getElementById('app-loader')!.textContent!,
    // Browsers hide the nonce attribute after parsing; the property keeps it.
    nonce: document.getElementById('app-loader')!.nonce || undefined,
  }

  // Hydrates the shell immediately; each Suspense boundary hydrates when its
  // HTML (and the response it needs) lands.
  hydrateRoot(
    document,
    <App
      env={env}
      audience="person"
      signedIn={signedIn}
      flags={data.flags}
      assets={assets}
      initial={{ route, params, refs, Page, href: location.pathname + location.search }}
    />,
    {
      // A boundary the server couldn't finish (e.g. its query failed) is
      // rendered here instead: expected degradation, not a crash.
      onRecoverableError(error) {
        console.warn('[ssr] boundary recovered on the client:', error)
        reportClientEvent({ type: 'recoverable-error', detail: String(error) })
      },
    },
  )
}
