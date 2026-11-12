#!/usr/bin/env node
// SEO parity: request the same paths from two servers as a verified Googlebot
// and compare what search engines read:
//   status code + redirect target, title, meta description, canonical URL,
//   robots tags, Open Graph + X card tags, number of language alternates,
//   structured-data (JSON-LD) types.
// Markup differences (quotes, attribute order, entities, whitespace) are
// normalised away; only meaning is compared.
//
// Usage:
//   seo-parity --old http://127.0.0.1:3301 --new http://127.0.0.1:3300 [path ...]
//   seo-parity --old ... --new ... --paths-file paths.txt
// Exit code 1 when any path differs.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Parser } from 'htmlparser2'

const DEFAULT_PATHS = [
  '/',
  '/ada',
  '/ADA',
  '/grace',
  '/nobody',
  '/ada.',
  '/ada%E3%80%82', // "ada。" pasted from a CJK chat
  '/ada/status/1001',
  '/ada/status/1005', // has a photo
  '/ada/status/1001!',
  '/ada/status/999999',
]

// What the edge forwards for a crawler it verified by IP.
const CRAWLER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'x-edge-verified-bot': 'search',
}

type Facts = Record<string, string>

export function extractFacts(html: string): Facts {
  const facts: Facts = {}
  let alternates = 0
  const ldTypes = new Set<string>()
  let inTitle = false
  let title = ''
  let ldBuf: string | null = null

  const parser = new Parser(
    {
      onopentag(name, a) {
        if (name === 'title' && !('title' in facts) && !inTitle) inTitle = true
        if (name === 'meta') {
          const key = (a.name ?? a.property ?? '').toLowerCase()
          const content = (a.content ?? '').trim()
          if (key === 'description') facts.description = squash(content)
          else if (key === 'robots' || key === 'googlebot') facts[`robots:${key}`] = normRobots(content)
          else if (key.startsWith('og:') || key.startsWith('twitter:')) facts[`meta:${key}`] = squash(content)
        }
        if (name === 'link') {
          const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('canonical')) facts.canonical = a.href ?? ''
          if (rel.includes('alternate') && a.hreflang) alternates++
        }
        if (name === 'script' && (a.type ?? '').toLowerCase() === 'application/ld+json') ldBuf = ''
      },
      ontext(text) {
        if (inTitle) title += text
        if (ldBuf !== null) ldBuf += text
      },
      onclosetag(name) {
        if (name === 'title' && inTitle) {
          inTitle = false
          facts.title = squash(title)
        }
        if (name === 'script' && ldBuf !== null) {
          try {
            collectTypes(JSON.parse(ldBuf), ldTypes)
          } catch {
            ldTypes.add('<invalid JSON-LD>')
          }
          ldBuf = null
        }
      },
    },
    { decodeEntities: true, lowerCaseAttributeNames: true },
  )
  parser.write(html)
  parser.end()

  facts.alternates = String(alternates)
  facts['jsonld:types'] = [...ldTypes].sort().join(', ') || '(none)'
  return facts
}

function collectTypes(node: unknown, out: Set<string>) {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === '@type') for (const t of [v].flat()) out.add(String(t))
    else collectTypes(v, out)
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const normRobots = (s: string) =>
  s
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .sort()
    .join(', ')

async function fetchFacts(base: string, path: string): Promise<Facts> {
  const res = await fetch(base + path, { headers: CRAWLER_HEADERS, redirect: 'manual' })
  const facts: Facts = { status: String(res.status) }
  if (res.status >= 300 && res.status < 400) {
    // Compare the target path, not the host each server happens to run on.
    const loc = res.headers.get('location') ?? ''
    const u = new URL(loc, base)
    facts.location = u.origin === new URL(base).origin ? u.pathname + u.search : u.href
    await res.body?.cancel()
    return facts
  }
  return { ...facts, ...extractFacts(await res.text()) }
}

type Diff = { field: string; old?: string; new?: string }

export function diffFacts(a: Facts, b: Facts): Diff[] {
  // If either side redirects, the page body is irrelevant: the redirect is the finding.
  const redirect = 'location' in a || 'location' in b
  const keys = (redirect ? ['status', 'location'] : [...new Set([...Object.keys(a), ...Object.keys(b)])]).sort(
    fieldOrder,
  )
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ field: k, old: a[k], new: b[k] }))
}

const ORDER = ['status', 'location', 'title', 'description', 'canonical', 'robots', 'meta', 'alternates', 'jsonld']
const rank = (k: string) => ORDER.findIndex((o) => k === o || k.startsWith(`${o}:`))
const fieldOrder = (x: string, y: string) => rank(x) - rank(y) || x.localeCompare(y)

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { old: { type: 'string' }, new: { type: 'string' }, 'paths-file': { type: 'string' } },
  })
  if (!values.old || !values.new) {
    console.error('usage: seo-parity.ts --old <base-url> --new <base-url> [--paths-file f] [path ...]')
    process.exit(2)
  }
  const paths = values['paths-file']
    ? readFileSync(values['paths-file'], 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : positionals.length
      ? positionals
      : DEFAULT_PATHS

  console.log(`SEO parity as verified Googlebot\n  old: ${values.old}\n  new: ${values.new}\n`)
  const fieldCounts = new Map<string, number>()
  let differing = 0
  const show = (v?: string) => (v === undefined ? '—' : JSON.stringify(v.length > 70 ? `${v.slice(0, 67)}...` : v))

  for (const path of paths) {
    const [a, b] = await Promise.all([fetchFacts(values.old, path), fetchFacts(values.new, path)])
    const diffs = diffFacts(a, b)
    if (!diffs.length) {
      console.log(`  ✓ ${path}`)
      continue
    }
    differing++
    console.log(`  ✗ ${path}`)
    for (const d of diffs) {
      fieldCounts.set(d.field, (fieldCounts.get(d.field) ?? 0) + 1)
      console.log(`      ${d.field.padEnd(22)} old: ${show(d.old)}\n      ${''.padEnd(22)} new: ${show(d.new)}`)
    }
  }

  console.log(`\n${paths.length} paths, ${paths.length - differing} match, ${differing} differ`)
  if (fieldCounts.size) {
    console.log(
      `fields: ${[...fieldCounts]
        .sort((x, y) => y[1] - x[1])
        .map(([f, n]) => `${f} ×${n}`)
        .join(', ')}`,
    )
  }
  process.exit(differing ? 1 : 0)
}

if (import.meta.main) await main()
