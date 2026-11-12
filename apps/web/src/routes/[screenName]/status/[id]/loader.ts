import { graphql } from 'react-relay'
import type { ConcreteRequest } from 'relay-runtime'
import type { RouteLoader } from '../../../../router/types.ts'
import type { PostQuery$data } from './__generated__/PostQuery.graphql.ts'

export const PostQuery = graphql`
  query PostQuery($id: ID!) {
    post(id: $id) {
      id
      text
      createdAt
      author {
        screenName
        name
      }
      media {
        url
        alt
      }
      ...PostCard_post
    }
  }
` as ConcreteRequest

export const ConversationQuery = graphql`
  query ConversationQuery($id: ID!) {
    post(id: $id) {
      replies(first: 50) {
        id
        ...PostCard_post
      }
    }
  }
` as ConcreteRequest

export default {
  primary: { query: PostQuery, variables: (p) => ({ id: p.id }) },
  // Link-preview bots skip this: replies are body-only.
  body: { conversation: { query: ConversationQuery, variables: (p) => ({ id: p.id }) } },
  head: (data: PostQuery$data, p) => {
    const post = data.post
    if (!post) return { status: 404, title: 'Post not found / X-ish', description: '', canonical: `/${p.screenName}/status/${p.id}`, ogType: 'article' }
    return {
      status: 200,
      title: `${post.author.name} on X-ish: "${post.text.slice(0, 60)}"`,
      description: post.text.slice(0, 200),
      canonical: `/${post.author.screenName}/status/${post.id}`,
      ogType: 'article',
      image: `/card/post/${post.id}.png`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SocialMediaPosting',
        headline: post.text.slice(0, 110),
        datePublished: post.createdAt,
        author: { '@type': 'Person', name: post.author.name, url: `/${post.author.screenName}` },
        // One URL per photo, described by its own alt text only.
        image: post.media.map((m) => ({ '@type': 'ImageObject', contentUrl: m.url, description: m.alt })),
      },
    }
  },
} satisfies RouteLoader
