import { useEffect, useState } from 'react'
import { relativeTime } from './relative-time.ts'

// The server (and so the hydration pass) renders the absolute time, which is
// the same everywhere; the browser switches to "3h" after hydrating, so the
// clock never causes a mismatch. Crawler documents never hydrate and keep the
// absolute time. The full timestamp stays available as the title.
export function Timestamp({ iso }: { iso: string }) {
  const absolute = new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
  const [label, setLabel] = useState(absolute)
  useEffect(() => {
    setLabel(relativeTime(iso, Date.now()))
  }, [iso])
  return (
    <time dateTime={iso} title={`${absolute} UTC`}>
      {label}
    </time>
  )
}
