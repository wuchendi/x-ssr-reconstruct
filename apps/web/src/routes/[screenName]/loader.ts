import { graphql } from 'react-relay'
import type { ConcreteRequest } from 'relay-runtime'
import type { RouteLoader } from '../../router/types.ts'
import type { ProfileHeaderQuery$data } from './__generated__/ProfileHeaderQuery.graphql.ts'

export const ProfileHeaderQuery = graphql`
  query ProfileHeaderQuery($screenName: String!) {
    user(screenName: $screenName) {
      id
      screenName
      name
      bio
      followers
    }
  }
` as ConcreteRequest

export const ProfileTimelineQuery = graphql`
  query ProfileTimelineQuery($screenName: String!) {
    user(screenName: $screenName) {
      posts(first: 20) {
        id
        ...PostCard_post
      }
    }
  }
` as ConcreteRequest

export default {
  primary: { query: ProfileHeaderQuery, variables: (p) => ({ screenName: p.screenName }) },
  body: { timeline: { query: ProfileTimelineQuery, variables: (p) => ({ screenName: p.screenName }) } },
  head: (data: ProfileHeaderQuery$data, p) => {
    const u = data.user
    if (!u) {
      // A real 404, not a 200 page that says "not found".
      return {
        status: 404,
        title: 'Account not found / X-ish',
        description: "This account doesn't exist.",
        canonical: `/${p.screenName}`,
        ogType: 'profile',
      }
    }
    return {
      status: 200,
      title: `${u.name} (@${u.screenName}) / X-ish`,
      description: u.bio,
      canonical: `/${u.screenName}`,
      ogType: 'profile',
      image: `/card/profile/${u.screenName}.png`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        mainEntity: { '@type': 'Person', name: u.name, alternateName: `@${u.screenName}`, description: u.bio },
      },
    }
  },
} satisfies RouteLoader
