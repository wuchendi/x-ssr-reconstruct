import { describe, expect, it } from 'vitest'
import { diffFacts, extractFacts } from './seo-parity.ts'

const reactStyle = `<!DOCTYPE html><html><head><title>Ada (@ada) / X-ish</title>
<meta name="description" content="Tom &amp; Jerry"/><link rel="canonical" href="https://x.example/ada"/>
<link rel="alternate" hrefLang="en" href="https://x.example/ada?lang=en"/>
<meta property="og:type" content="profile"/><meta name="robots" content="noindex, nofollow"/>
<script type="application/ld+json">{"@type":"ProfilePage","mainEntity":{"@type":"Person"}}</script></head><body></body></html>`

// Same meaning, different markup: quotes, attribute order, entities, spacing, token order.
const legacyStyle = `<!doctype html><html><head>
<title>  Ada (@ada)   / X-ish </title>
<meta content='Tom &#38; Jerry' name='description'><link href='https://x.example/ada' rel='canonical'>
<link rel=alternate hreflang=en href='https://x.example/ada?lang=en'>
<meta content='profile' property='og:type'><meta content='NOFOLLOW,noindex' name='robots'>
</head><body><script type="application/ld+json">[{"@type":"Person"},{"@type":"ProfilePage"}]</script></body></html>`

describe('extractFacts', () => {
  it('reads every field search engines use', () => {
    expect(extractFacts(reactStyle)).toEqual({
      title: 'Ada (@ada) / X-ish',
      description: 'Tom & Jerry',
      canonical: 'https://x.example/ada',
      alternates: '1',
      'meta:og:type': 'profile',
      'robots:robots': 'nofollow, noindex',
      'jsonld:types': 'Person, ProfilePage',
    })
  })

  it('normalises markup differences away', () => {
    expect(diffFacts(extractFacts(legacyStyle), extractFacts(reactStyle))).toEqual([])
  })

  it('flags invalid JSON-LD instead of throwing', () => {
    expect(extractFacts('<script type="application/ld+json">{oops</script>')['jsonld:types']).toBe('<invalid JSON-LD>')
  })
})

describe('diffFacts', () => {
  it('reports missing, extra and changed fields', () => {
    const diffs = diffFacts({ status: '200', title: 'a', 'meta:og:type': 'profile' }, { status: '200', title: 'b', 'robots:robots': 'noindex' })
    expect(diffs).toEqual([
      { field: 'title', old: 'a', new: 'b' },
      { field: 'robots:robots', old: undefined, new: 'noindex' },
      { field: 'meta:og:type', old: 'profile', new: undefined },
    ])
  })

  it('compares only status and target when either side redirects', () => {
    const diffs = diffFacts({ status: '301', location: '/ada' }, { status: '404', title: 'Not found', canonical: 'x' })
    expect(diffs.map((d) => d.field)).toEqual(['status', 'location'])
  })
})
