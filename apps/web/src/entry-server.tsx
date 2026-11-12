import { PassThrough, type Readable } from 'node:stream'
import { renderToPipeableStream } from 'react-dom/server'
import { createOperationDescriptor } from 'relay-runtime'
import { App } from './app/App.tsx'
import { stylesheetFirstLoader } from './app/boot-scripts.ts'
import { createServerEnvironment, type FetchGraphQL } from './relay/server.ts'
import { loadRoute, primarySettled } from './router/load.ts'
import { matchRoute } from './router/routes.ts'
import type { Audience } from './router/types.ts'
import { ResponseInjector } from './ssr/inject.ts'

export { routes } from './router/routes.ts'

export type RouteAssets = { css: string[]; entry: string; preloads: string[] }

export type RenderInput = {
  url: string
  audience: Audience
  signedIn: boolean
  flags: Record<string, boolean>
  fetchGraphQL: FetchGraphQL
  resolveAssets: (routeId: string, signedIn: boolean) => RouteAssets
  onError: (err: unknown) => void
}

export type RenderResult = { status: number; body: Readable } | { status: 'unowned' }

export async function render(input: RenderInput): Promise<RenderResult> {
  const url = new URL(input.url, 'http://local')
  const match = matchRoute(url.pathname, input.signedIn)
  // Not a route of the new app: in production the edge never sends it here,
  // it goes to rweb.
  if (!match) return { status: 'unowned' }
  const { route, params } = match
  const { audience } = input

  const injector = new ResponseInjector()
  const env = createServerEnvironment(input.fetchGraphQL, (key, json) => {
    // Crawler documents never hydrate: they carry no data for the client.
    if (audience === 'person') injector.pushResponse(key, json)
  })

  // Route loaders start every GraphQL request *before* rendering begins.
  // Preview bots: head data only, timeline/conversation never requested.
  const refs = route.loader.clientOnly ? {} : loadRoute(env, route, params, { headOnly: audience === 'preview' })

  // The page chunk and the primary query in parallel. The primary query
  // decides the status code (real 404s) and <head>, so it gates the first byte.
  const [pageMod] = await Promise.all([route.page(), primarySettled(refs.primary)])

  let primaryData: unknown = null
  if (route.loader.primary) {
    const op = createOperationDescriptor(route.loader.primary.query, route.loader.primary.variables(params))
    primaryData = env.lookup(op.fragment).data
  }
  const status = route.loader.head(primaryData, params).status

  const a = input.resolveAssets(route.id, input.signedIn)
  const assets = { css: a.css, loaderScript: stylesheetFirstLoader(a.entry, a.preloads) }

  const element = (
    <App
      env={env}
      audience={audience}
      signedIn={input.signedIn}
      flags={input.flags}
      assets={assets}
      initial={{ route, params, refs, Page: pageMod.default, href: url.pathname + url.search }}
    />
  )

  return new Promise((resolve, reject) => {
    let failedBeforeShell = true
    const stream = renderToPipeableStream(element, {
      // Waiting for onAllReady is not enough: React still outlines a completed
      // boundary (hidden <div> + <template> + $RC script) once the bytes
      // flushed so far plus the boundary exceed progressiveChunkSize (12,800 by
      // default). Crawler documents must have every boundary resolved in place
      // and work without JS, so lift the threshold for bots.
      progressiveChunkSize: audience === 'person' ? undefined : Number.POSITIVE_INFINITY,
      // People: send the shell as soon as it's ready, stream the rest.
      onShellReady() {
        if (audience !== 'person') return
        failedBeforeShell = false
        stream.pipe(injector)
        resolve({ status, body: injector })
      },
      // Verified crawlers and link-preview bots: wait for every Suspense
      // boundary and send one finished document, resolved in place.
      onAllReady() {
        if (audience === 'person') return
        failedBeforeShell = false
        const out = new PassThrough()
        stream.pipe(out)
        resolve({ status, body: out })
      },
      onShellError(err) {
        reject(err)
      },
      onError(err) {
        if (!failedBeforeShell) input.onError(err)
      },
    })
  })
}
