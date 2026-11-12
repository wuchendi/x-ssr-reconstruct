// X-style compact relative time: "5s", "3m", "5h", "6d", then "Nov 1"
// (plus the year when it isn't the current one).
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  const date = new Date(then)
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  if (date.getUTCFullYear() !== new Date(now).getUTCFullYear()) options.year = 'numeric'
  return date.toLocaleDateString('en-US', options)
}
