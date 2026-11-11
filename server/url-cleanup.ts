// Ported from rweb SSR's URL cleanup rules. Links pasted into chats often
// pick up trailing punctuation ("x.com/ada." or "x.com/ada。"); rweb SSR
// answered those with a 301 to the clean URL, and search engines rely on it.
const TRAILING_PUNCT = /[.,!?;:)。、，！？]+$/

// Returns the clean same-origin path to redirect to, or null if the path is
// already clean or can't be redirected safely.
export function cleanPath(rawPath: string): string | null {
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  const clean = path.replace(TRAILING_PUNCT, '')
  if (clean === path || clean.length <= 1) return null
  // Location must stay a single-slash absolute path on this origin.
  // "//evil.com" is protocol-relative, and browsers treat "/\evil.com" the
  // same way; both would turn this rule into an open redirect.
  if (!clean.startsWith('/') || clean.startsWith('//') || clean.includes('\\')) return null
  // Re-encode: decoded characters must not be written into the header raw.
  return encodeURI(clean)
}
