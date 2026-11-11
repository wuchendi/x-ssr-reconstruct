// Ported from rweb SSR's URL cleanup rules. Links pasted into chats often
// pick up trailing punctuation ("x.com/ada." or "x.com/ada。"); rweb SSR
// answered those with a 301 to the clean URL, and search engines rely on it.
const TRAILING_PUNCT = /[.,!?;:)。、，！？]+$/

// Returns the clean path to redirect to, or null if the path is already clean.
export function cleanPath(rawPath: string): string | null {
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  const clean = path.replace(TRAILING_PUNCT, '')
  return clean !== path && clean.length > 1 ? clean : null
}
