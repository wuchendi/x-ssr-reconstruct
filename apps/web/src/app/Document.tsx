import type { ReactNode } from 'react'
import { usePreloadedQuery } from 'react-relay'
import type { ConcreteRequest } from 'relay-runtime'
import type { HeadData, Params, Refs, RouteDef } from '../router/types.ts'
import { REPLAY_REGISTRY } from './boot-scripts.ts'
import { useApp } from './context.ts'

export type Assets = { css: string[]; loaderScript: string; nonce?: string }

const ORIGIN = 'https://x.example'

// Hooks can't be called conditionally, so routes with and without a primary
// query render different components rather than one with an `if`.
function RouteHead({ route, refs, params }: { route: RouteDef; refs: Refs; params: Params }) {
  const primary = route.loader.primary
  if (!primary) return <HeadTags head={route.loader.head(null, params)} />
  return <PrimaryRouteHead query={primary.query} queryRef={refs.primary} route={route} params={params} />
}

function PrimaryRouteHead(props: { query: ConcreteRequest; queryRef: Refs[string]; route: RouteDef; params: Params }) {
  // Already settled on the server before render started, so this never
  // suspends there; in the browser it replays the streamed response.
  const data = usePreloadedQuery(props.query, props.queryRef)
  return <HeadTags head={props.route.loader.head(data, props.params)} />
}

function HeadTags({ head }: { head: HeadData }) {
  const { audience } = useApp()
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
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD from our own data; "<" is escaped
          dangerouslySetInnerHTML={{ __html: JSON.stringify(head.jsonLd).replace(/</g, '\\u003c') }}
        />
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
        {audience === 'person' && (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: constant inline script (replay registry)
          <script nonce={props.assets.nonce} dangerouslySetInnerHTML={{ __html: REPLAY_REGISTRY }} />
        )}
        {/* What the browser needs to render exactly what the server rendered. */}
        {audience === 'person' && (
          <script
            id="app-data"
            type="application/json"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON data block, not executed; "<" is escaped
            dangerouslySetInnerHTML={{ __html: JSON.stringify({ flags }).replace(/</g, '\\u003c') }}
          />
        )}
        <RouteHead route={props.route} refs={props.refs} params={props.params} />
        {props.assets.css.map((href, i) => (
          <link key={href} id={i === 0 ? 'app-css' : undefined} rel="stylesheet" href={href} />
        ))}
        {audience === 'person' && (
          <script
            id="app-loader"
            nonce={props.assets.nonce}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: loader script built by stylesheetFirstLoader(); its payload is JSON with "<" escaped
            dangerouslySetInnerHTML={{ __html: props.assets.loaderScript }}
          />
        )}
      </head>
      <body>
        {/* Preview bots get head only: the body is never rendered for them. */}
        {audience !== 'preview' && <div id="app">{props.children}</div>}
      </body>
    </html>
  )
}
