// Stand-in for X's GraphQL API. Latencies are deliberately uneven so the
// streaming behaviour is visible: profile headers are fast, timelines and
// conversations are slow.
import { readFileSync } from 'node:fs'
import { buildSchema, graphql } from 'graphql'

const schema = buildSchema(readFileSync(new URL('../schema.graphql', import.meta.url), 'utf8'))

const LATENCY_MS = {
  user: 60,
  post: 60,
  posts: 450,
  replies: Number(process.env.REPLIES_LATENCY_MS ?? 650),
  homeTimeline: 300,
}
// MOCK_LATENCY_SCALE multiplies every latency; 0 removes them (load tests
// that measure rendering rather than waiting).
const LATENCY_SCALE = Number(process.env.MOCK_LATENCY_SCALE ?? 1)
const sleep = (ms: number) => {
  const scaled = ms * LATENCY_SCALE
  return scaled > 0 ? new Promise((r) => setTimeout(r, scaled)) : Promise.resolve()
}

type UserRow = { id: string; screenName: string; name: string; bio: string; followers: number }
type PostRow = { id: string; authorId: string; text: string; createdAt: string; replyTo?: string; photo?: string }

const users: UserRow[] = [
  { id: 'u1', screenName: 'ada', name: 'Ada', bio: 'Analytical engines, mostly.', followers: 18_400 },
  { id: 'u2', screenName: 'grace', name: 'Grace', bio: 'Compilers and nanoseconds.', followers: 9_120 },
]

const posts: PostRow[] = []
for (let i = 1; i <= 40; i++) {
  const author = users[i % 2]
  posts.push({
    id: String(1000 + i),
    authorId: author.id,
    text: `Post #${i} from @${author.screenName}: ${'a long enough body to make the HTML non-trivial. '.repeat(3)}`,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString(),
    photo: i % 5 === 0 ? `/media/${i}.webp` : undefined,
  })
}
for (let i = 1; i <= 30; i++) {
  posts.push({
    id: String(5000 + i),
    authorId: users[i % 2].id,
    text: `Reply ${i} </script><b>escaped?</b>`,
    createdAt: new Date(Date.UTC(2026, 10, 2, 9, i)).toISOString(),
    replyTo: '1001',
  })
}

function userNode(u: UserRow) {
  return {
    ...u,
    posts: async ({ first }: { first: number }) => {
      await sleep(LATENCY_MS.posts)
      return posts
        .filter((p) => p.authorId === u.id && !p.replyTo)
        .slice(0, first)
        .map(postNode)
    },
  }
}

function postNode(p: PostRow): Record<string, unknown> {
  return {
    id: p.id,
    text: p.text,
    createdAt: p.createdAt,
    author: () => userNode(users.find((u) => u.id === p.authorId)!),
    media: p.photo ? [{ url: p.photo, alt: `Photo attached to post ${p.id}` }] : [],
    replies: async ({ first }: { first: number }) => {
      await sleep(LATENCY_MS.replies)
      return posts
        .filter((r) => r.replyTo === p.id)
        .slice(0, first)
        .map(postNode)
    },
  }
}

const root = {
  user: async ({ screenName }: { screenName: string }) => {
    await sleep(LATENCY_MS.user)
    const u = users.find((x) => x.screenName.toLowerCase() === screenName.toLowerCase())
    return u ? userNode(u) : null
  },
  post: async ({ id }: { id: string }) => {
    await sleep(LATENCY_MS.post)
    const p = posts.find((x) => x.id === id)
    return p ? postNode(p) : null
  },
  homeTimeline: async ({ first }: { first: number }) => {
    await sleep(LATENCY_MS.homeTimeline)
    return posts
      .filter((p) => !p.replyTo)
      .slice(0, first)
      .map(postNode)
  },
}

export type GraphQLRequest = { query: string; variables: Record<string, unknown> }

export async function executeGraphQL(req: GraphQLRequest, auth: { guestToken?: string; userToken?: string }) {
  if (!auth.guestToken && !auth.userToken) return { errors: [{ message: 'unauthenticated' }] }
  return graphql({ schema, source: req.query, variableValues: req.variables, rootValue: root })
}

// Upstreams a logged-out render needs before it can start. Neither depends on
// the other, which is the point of the "No waiting on a guest token" fix.
export async function fetchGuestToken(): Promise<string> {
  await sleep(80)
  return `gt-${Math.random().toString(36).slice(2, 10)}`
}

export async function fetchFeatureFlags(_ctx: { country: string }): Promise<Record<string, boolean>> {
  await sleep(70)
  return { signup_banner: true, web_new_app: true }
}
