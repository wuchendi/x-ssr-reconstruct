import { Suspense } from 'react'
import { usePreloadedQuery } from 'react-relay'
import { PostCard } from '../../components/PostCard.tsx'
import { SignupBanner } from '../../components/SignupBanner.tsx'
import { PostSkeletons } from '../../components/Skeleton.tsx'
import type { PageProps } from '../../router/types.ts'
import type { ProfileHeaderQuery as HeaderOp } from './__generated__/ProfileHeaderQuery.graphql.ts'
import type { ProfileTimelineQuery as TimelineOp } from './__generated__/ProfileTimelineQuery.graphql.ts'
import { ProfileHeaderQuery, ProfileTimelineQuery } from './loader.ts'

export default function Profile({ refs }: PageProps) {
  // Primary data is already in the store: the header is part of the shell.
  const { user } = usePreloadedQuery<HeaderOp>(ProfileHeaderQuery, refs.primary as never)
  if (!user)
    return (
      <section className="profile">
        <h1>This account doesn't exist</h1>
      </section>
    )
  return (
    <>
      <section className="profile">
        <h1>{user.name}</h1>
        <div className="muted">@{user.screenName}</div>
        <p>{user.bio}</p>
        <div>
          <b>{user.followers.toLocaleString('en-US')}</b> <span className="muted">Followers</span>
        </div>
      </section>
      {/* Streams in later: the shell (header) is sent before this resolves. */}
      <Suspense fallback={<PostSkeletons />}>
        <Timeline queryRef={refs.timeline} />
      </Suspense>
      <SignupBanner />
    </>
  )
}

function Timeline({ queryRef }: { queryRef: PageProps['refs'][string] }) {
  const { user } = usePreloadedQuery<TimelineOp>(ProfileTimelineQuery, queryRef as never)
  return (
    <>
      {user?.posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </>
  )
}
