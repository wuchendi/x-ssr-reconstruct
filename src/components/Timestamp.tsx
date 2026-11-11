import { useApp } from '../app/context.ts'

// Crawlers get the absolute time only. Relative "3h" formatting is
// browser-side output and is left out of crawler documents.
export function Timestamp({ iso }: { iso: string }) {
  const { audience } = useApp()
  const label = new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
  return (
    <time dateTime={iso} data-relative={audience === 'person' ? '' : undefined}>
      {label}
    </time>
  )
}
