// Stand-in for the old crawler servers (rweb SSR + Jetfuel SSR), used only as
// the *specification* side of @x-ssr/seo-parity.
//
// It reads the same mock data but renders with its own hand-written template
// (single quotes, different attribute order, unquoted attributes), so parity
// has to compare meaning, not markup. It also keeps behaviours the new app
// did not have at first, the kind of gaps the post says the parity work
// closed one by one:
//   1. rweb SSR URL cleanup: trailing punctuation -> 301 to the clean URL
//   2. 404 pages carry <meta name="robots" content="noindex">
//   3. an x-default language alternate
//   4. og:type
import { createServer } from 'node:http'
import { executeGraphQL } from '@x-ssr/mock-api'
// Same rule, shared: a second hand-rolled copy is where the redirect guard
// would be forgotten.
import { cleanPath as cleanUrl } from '@x-ssr/url-cleanup'

const ORIGIN = 'https://x.example'
const AUTH = { guestToken: 'legacy-ssr' }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const jsonLd = (v: unknown) => `<script type="application/ld+json">${JSON.stringify(v).replace(/</g, '\\u003c')}</script>`

type Head = { status: number; title: string; description: string; canonical: string; image?: string; ogType: string; ld?: unknown }

function page(h: Head): string {
  // Every interpolated value is escaped: canonical comes from the request path,
  // so "/x'><script>..." must not break out of an attribute.
  const canonical = esc(ORIGIN + h.canonical)
  const alt = ['en', 'ja', 'es'].map((l) => `<link rel=alternate hreflang=${l} href='${esc(`${ORIGIN}${h.canonical}?lang=${l}`)}'>`).join('')
  return `<!doctype html><html><head>
<title>${esc(h.title)}</title>
<meta content='${esc(h.description)}' name='description'>
${h.status === 404 ? `<meta content='noindex' name='robots'>` : ''}
<link href='${canonical}' rel='canonical'>
<link rel='alternate' hreflang='x-default' href='${canonical}'>${alt}
<meta content='${esc(h.title)}' property='og:title'><meta content='${esc(h.description)}' property='og:description'>
<meta content='${esc(h.ogType)}' property='og:type'>
${h.image ? `<meta content='${esc(ORIGIN + h.image)}' property='og:image'>` : ''}
<meta content='${h.image ? 'summary_large_image' : 'summary'}' name='twitter:card'>
</head><body>${h.ld ? jsonLd(h.ld) : ''}<noscript>legacy body</noscript></body></html>`
}

async function profile(screenName: string): Promise<Head> {
  const r = await executeGraphQL(
    { query: 'query($s:String!){user(screenName:$s){screenName name bio}}', variables: { s: screenName } },
    AUTH,
  )
  const u = ((r as { data?: unknown }).data as { user: { screenName: string; name: string; bio: string } | null }).user
  if (!u) return { status: 404, title: 'Account not found / X-ish', description: "This account doesn't exist.", canonical: `/${screenName}`, ogType: 'profile' }
  return {
    status: 200,
    title: `${u.name} (@${u.screenName}) / X-ish`,
    description: u.bio,
    canonical: `/${u.screenName}`,
    image: `/card/profile/${u.screenName}.png`,
    ogType: 'profile',
    ld: { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: u.name, alternateName: `@${u.screenName}`, description: u.bio } },
  }
}

async function post(screenName: string, id: string): Promise<Head> {
  const r = await executeGraphQL(
    { query: 'query($id:ID!){post(id:$id){id text createdAt author{screenName name} media{url alt}}}', variables: { id } },
    AUTH,
  )
  type P = { id: string; text: string; createdAt: string; author: { screenName: string; name: string }; media: { url: string; alt: string }[] }
  const p = ((r as { data?: unknown }).data as { post: P | null }).post
  if (!p) return { status: 404, title: 'Post not found / X-ish', description: '', canonical: `/${screenName}/status/${id}`, ogType: 'article' }
  return {
    status: 200,
    title: `${p.author.name} on X-ish: "${p.text.slice(0, 60)}"`,
    description: p.text.slice(0, 200),
    canonical: `/${p.author.screenName}/status/${p.id}`,
    image: `/card/post/${p.id}.png`,
    ogType: 'article',
    ld: {
      '@context': 'https://schema.org',
      '@type': 'SocialMediaPosting',
      headline: p.text.slice(0, 110),
      datePublished: p.createdAt,
      author: { '@type': 'Person', name: p.author.name, url: `/${p.author.screenName}` },
      image: p.media.map((m) => ({ '@type': 'ImageObject', contentUrl: m.url, description: m.alt })),
    },
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const clean = cleanUrl(path)
  if (clean) {
    res.writeHead(301, { location: clean }).end()
    return
  }
  let head: Head
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) head = { status: 200, title: 'X-ish', description: 'Reconstruction demo', canonical: '/', ogType: 'website' }
  else if (segs.length === 1) head = await profile(decodeURIComponent(segs[0]))
  else if (segs.length === 3 && segs[1] === 'status') head = await post(segs[0], segs[2])
  else head = { status: 404, title: 'Page not found / X-ish', description: '', canonical: path, ogType: 'website' }
  res.writeHead(head.status, { 'content-type': 'text/html; charset=utf-8' }).end(page(head))
})

const port = Number(process.env.PORT ?? 3301)
server.listen(port, '0.0.0.0', () => console.log(`legacy SSR listening on ${port}`))
