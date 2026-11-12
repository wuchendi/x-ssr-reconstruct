import { usePreloadedQuery } from 'react-relay'
import { PostCard } from '../../../../components/PostCard.tsx'
import { PostSkeletons } from '../../../../components/Skeleton.tsx'
import { StreamedSection } from '../../../../components/StreamedSection.tsx'
import type { PageProps } from '../../../../router/types.ts'
import type { ConversationQuery as ConvOp } from './__generated__/ConversationQuery.graphql.ts'
import type { PostQuery as PostOp } from './__generated__/PostQuery.graphql.ts'
import { ConversationQuery, PostQuery } from './loader.ts'

export default function PostPage({ refs }: PageProps) {
  const { post } = usePreloadedQuery<PostOp>(PostQuery, refs.primary as never)
  if (!post) return <h1>This post doesn't exist</h1>
  return (
    <>
      <PostCard post={post} />
      <StreamedSection
        query={ConversationQuery}
        queryRef={refs.conversation}
        what="replies"
        fallback={<PostSkeletons n={5} />}
      >
        {(queryRef) => <Conversation queryRef={queryRef} />}
      </StreamedSection>
    </>
  )
}

function Conversation({ queryRef }: { queryRef: PageProps['refs'][string] }) {
  const { post } = usePreloadedQuery<ConvOp>(ConversationQuery, queryRef as never)
  return (
    <>
      {post?.replies.map((r) => (
        <PostCard key={r.id} post={r} />
      ))}
    </>
  )
}
