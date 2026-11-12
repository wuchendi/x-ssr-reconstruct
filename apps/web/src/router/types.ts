import type { ComponentType } from 'react'
import type { ConcreteRequest, OperationType, Variables } from 'relay-runtime'
import type { PreloadedQuery } from 'react-relay'

export type Params = Record<string, string>
export type Audience = 'person' | 'crawler' | 'preview'

export type QuerySpec = { query: ConcreteRequest; variables: (params: Params) => Variables }

export type HeadData = {
  status: number
  title: string
  description: string
  canonical: string
  image?: string
  ogType: 'website' | 'profile' | 'article'
  // Structured data only crawlers get.
  jsonLd?: Record<string, unknown>
}

export type RouteLoader = {
  // Awaited before the first byte: decides status code and <head>. Kept small.
  primary?: QuerySpec
  // Streamed behind Suspense. Skipped entirely for link-preview bots.
  body?: Record<string, QuerySpec>
  head: (primaryData: any, params: Params) => HeadData
  // Signed-in Home renders only in the browser in the new app.
  clientOnly?: boolean
  signedInOnly?: boolean
}

export type Refs = Record<string, PreloadedQuery<OperationType>>
export type PageProps = { refs: Refs; params: Params }
export type PageModule = { default: ComponentType<PageProps> }

export type RouteDef = {
  id: string
  pattern: string
  regex: RegExp
  paramNames: string[]
  loader: RouteLoader
  page: () => Promise<PageModule>
}
