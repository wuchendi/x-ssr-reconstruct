import { useRef } from 'react'
import { graphql, useFragment } from 'react-relay'
import { useApp } from '../app/context.ts'
import type { PostCard_post$key } from './__generated__/PostCard_post.graphql.ts'
import { Link } from './Link.tsx'
import { Timestamp } from './Timestamp.tsx'

const DWELL_MS = 100

// Posts aren't plain links, so the intent signal is different: the pointer has
// to *move* onto the post and rest for 100ms, or press it. A post that scrolls
// under a still pointer gets no pointermove, so it doesn't preload.
export function PostCard({ post }: { post: PostCard_post$key }) {
  const p = useFragment(
    graphql`
      fragment PostCard_post on Post {
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
      }
    `,
    post,
  )
  const { navigate, preload } = useApp()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const href = `/${p.author.screenName}/status/${p.id}`
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking anywhere on a post is a mouse shortcut; keyboard users follow the timestamp link
    <article
      className="post"
      data-post-id={p.id}
      onPointerMove={() => {
        if (!timer.current) timer.current = setTimeout(() => preload(href), DWELL_MS)
      }}
      onPointerLeave={cancel}
      onPointerDown={() => {
        cancel()
        preload(href)
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return
        navigate(href)
      }}
    >
      <header>
        <a href={`/${p.author.screenName}`}>
          <b>{p.author.name}</b> <span className="muted">@{p.author.screenName}</span>
        </a>{' '}
        · {/* The timestamp links to the post, as on X: the keyboard path to it. */}
        <Link href={href}>
          <Timestamp iso={p.createdAt} />
        </Link>
      </header>
      <p>{p.text}</p>
      {p.media.map((m) => (
        // Requested as WebP; the image CDN serves these at ~half the JPEG size.
        <img key={m.url} src={m.url} alt={m.alt} width={480} height={270} loading="lazy" />
      ))}
      <ActionBar />
    </article>
  )
}

// Every post used to inline seven full SVG icons (~2 KB). Now each <use>
// points at one hidden sprite in the page.
function ActionBar() {
  return (
    <div className="actions">
      {['reply', 'repost', 'like', 'views', 'bookmark', 'share', 'more'].map((i) => (
        <svg key={i} width="18" height="18" aria-label={i}>
          <use href={`#i-${i}`} />
        </svg>
      ))}
    </div>
  )
}

export function IconSprite() {
  return (
    <svg width="0" height="0" className="icon-sprite" aria-hidden="true">
      {['reply', 'repost', 'like', 'views', 'bookmark', 'share', 'more'].map((i, n) => (
        <symbol key={i} id={`i-${i}`} viewBox="0 0 24 24">
          <circle cx="12" cy="12" r={4 + n} fill="none" stroke="currentColor" />
        </symbol>
      ))}
    </svg>
  )
}
