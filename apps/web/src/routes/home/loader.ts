import { graphql } from 'react-relay'
import type { ConcreteRequest } from 'relay-runtime'
import type { RouteLoader } from '../../router/types.ts'

export const HomeTimelineQuery = graphql`
  query HomeTimelineQuery {
    homeTimeline(first: 20) {
      id
      ...PostCard_post
    }
  }
` as ConcreteRequest

export default {
  body: { home: { query: HomeTimelineQuery, variables: () => ({}) } },
  head: () => ({ status: 200, title: 'Home / X-ish', description: '', canonical: '/home', ogType: 'website' }),
  // Signed-in Home renders only in the browser, in both apps.
  clientOnly: true,
  signedInOnly: true,
} satisfies RouteLoader
