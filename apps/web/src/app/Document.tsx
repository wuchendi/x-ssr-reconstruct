import type { ReactNode } from 'react'
import { usePreloadedQuery } from 'react-relay'
import type { Params, Refs, RouteDef } from '../router/types.ts'
import { useApp } from './context.ts'
import { REPLAY_REGISTRY } from './boot-scripts.ts'

export type Assets = { css: string[]; loaderScript: string }

const ORIGIN = 'https://x.example'

function RouteHead({ route, refs, params }: { route: RouteDef; refs: Refs; params: Params }) {
  const { audience } = useApp()
  const primary = route.loader.primary
  // Already settled on the server before render started, so this never
  // suspends there; in the browser it replays the streamed response.
  const data = primary ? usePreloadedQuery(primary.query, refs.primary) : null
  const head = route.loader.head(data, params)
  return (
    <>
      <title>{head.title}</title>
      <meta name="description" content={head.description} />
      {/* Parity with Jetfuel SSR: not-found pages are not indexed. */}
      {head.status === 404 && <meta name="robots" content="noindex" />}
      <link rel="canonical" href={ORIGIN + head.canonical} />
      {/* Parity with Jetfuel SSR: x-default plus one alternate per language. */}
      <link rel="alternate" hrefLang="x-default" href={ORIGIN + head.canonical} />
      {['en', 'ja', 'es'].map((l) => (
        <link key={l} rel="alternate" hrefLang={l} href={`${ORIGIN}${head.canonical}?lang=${l}`} />
      ))}
      <meta property="og:title" content={head.title} />
      <meta property="og:description" content={head.description} />
      <meta property="og:type" content={head.ogType} />
      {head.image && <meta property="og:image" content={ORIGIN + head.image} />}
      <meta name="twitter:card" content={head.image ? 'summary_large_image' : 'summary'} />
      {audience === 'crawler' && head.jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(head.jsonLd).replace(/</g, '\\u003c') }} />
      )}
    </>
  )
}

export function Document(props: { route: RouteDef; refs: Refs; params: Params; assets: Assets; children: ReactNode }) {
  const { audience, flags } = useApp()
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {audience === 'person' && <script dangerouslySetInnerHTML={{ __html: REPLAY_REGISTRY }} />}
        {/* What the browser needs to render exactly what the server rendered. */}
        {audience === 'person' && (
          <script id="app-data" type="application/json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ flags }).replace(/</g, '\\u003c') }} />
        )}
        <RouteHead route={props.route} refs={props.refs} params={props.params} />
        {props.assets.css.map((href, i) => (
          <link key={href} id={i === 0 ? 'app-css' : undefined} rel="stylesheet" href={href} />
        ))}
        {audience === 'person' && <script id="app-loader" dangerouslySetInnerHTML={{ __html: props.assets.loaderScript }} />}
      </head>
      <body>
        {/* Preview bots get head only: the body is never rendered for them. */}
        {audience !== 'preview' && <div id="app">{props.children}</div>}
      </body>
    </html>
  )
}
