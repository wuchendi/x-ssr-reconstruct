import { Suspense, useSyncExternalStore } from 'react'
import { usePreloadedQuery } from 'react-relay'
import { PostCard } from '../../components/PostCard.tsx'
import { PostSkeletons } from '../../components/Skeleton.tsx'
import type { PageProps } from '../../router/types.ts'
import { HomeTimelineQuery } from './loader.ts'
import type { HomeTimelineQuery as HomeOp } from './__generated__/HomeTimelineQuery.graphql.ts'

const noop = () => () => {}

export default function Home({ refs }: PageProps) {
  // false on the server and during hydration, true afterwards.
  const isClient = useSyncExternalStore(noop, () => true, () => false)
  if (!isClient || !refs.home) return <PostSkeletons n={6} />
  return (
    <Suspense fallback={<PostSkeletons n={6} />}>
      <Feed queryRef={refs.home} />
    </Suspense>
  )
}

function Feed({ queryRef }: { queryRef: PageProps['refs'][string] }) {
  const data = usePreloadedQuery<HomeOp>(HomeTimelineQuery, queryRef as never)
  return <>{data.homeTimeline.map((p) => <PostCard key={p.id} post={p} />)}</>
}
