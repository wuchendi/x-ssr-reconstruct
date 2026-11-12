// The real SSR entry, rendering real routes with the mock API's data. Guards
// the security properties of the HTML we stream (CSP nonces, no script
// injection) and how rendering stops (timeout, client disconnect).
import { readFileSync } from 'node:fs'
import { executeGraphQL } from '@x-ssr/mock-api'
import { Parser } from 'htmlparser2'
import { describe, expect, it } from 'vitest'
import type { RenderInput } from '../entry-server.tsx'
import { render } from '../entry-server.tsx'
import type { FetchGraphQL } from '../relay/server.ts'

const persisted: Record<string, string> = JSON.parse(
  readFileSync(new URL('../__generated__/persisted-queries.json', import.meta.url), 'utf8'),
)
const operationName = (id: string) => /^\s*query\s+(\w+)/.exec(persisted[id] ?? '')?.[1]
const mockApi: FetchGraphQL = (id, variables) =>
  executeGraphQL({ query: persisted[id], variables }, { guestToken: 'test' }) as ReturnType<FetchGraphQL>

async function renderHtml(url: string, overrides: Partial<RenderInput> = {}) {
  const result = await render({
    url,
    audience: 'person',
    signedIn: false,
    flags: { signup_banner: true },
    fetchGraphQL: mockApi,
    resolveAssets: () => ({ css: ['/assets/app.css'], entry: '/assets/entry.js', preloads: ['/assets/chunk.js'] }),
    onError: () => {},
    ...overrides,
  })
  if (result.status === 'unowned') throw new Error(`not a route: ${url}`)
  let html = ''
  for await (const chunk of result.body) html += chunk
  return { status: result.status, html }
}

type El = { name: string; attrs: Record<string, string>; text: string }
function parse(html: string) {
  const elements: El[] = []
  const open: El[] = []
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const el = { name, attrs, text: '' }
        elements.push(el)
        open.push(el)
      },
      ontext(text) {
        for (const el of open) el.text += text
      },
      onclosetag() {
        open.pop()
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  return elements
}
const DATA_TYPES = ['application/json', 'application/ld+json']
const isExecutable = (el: El) => el.name === 'script' && !DATA_TYPES.includes(el.attrs.type ?? '')

describe('CSP nonces', () => {
  it('puts the nonce on every executable script: ours, the stream injector, and React', async () => {
    const nonce = 'n0nce+/='
    const { html } = await renderHtml('/ada/status/1001', { nonce })
    const scripts = parse(html).filter(isExecutable)
    // replay registry, loader, at least one __rr.p() and React's streaming script
    expect(scripts.length).toBeGreaterThanOrEqual(4)
    for (const s of scripts) expect(s.attrs.nonce, s.text.slice(0, 40)).toBe(nonce)
  })

  it('emits no nonce attributes when CSP is off (dev)', async () => {
    const { html } = await renderHtml('/ada')
    expect(parse(html).some((el) => 'nonce' in el.attrs)).toBe(false)
  })
})

describe('script injection', () => {
  it('has no inline event handlers and no javascript: URLs', async () => {
    const els = parse((await renderHtml('/ada/status/1001', { nonce: 'n' })).html)
    for (const el of els) {
      for (const [name, value] of Object.entries(el.attrs)) {
        expect(name.startsWith('on'), `${el.name}[${name}]`).toBe(false)
        if (name === 'href' || name === 'src') expect(value.trim().toLowerCase().startsWith('javascript:')).toBe(false)
      }
    }
  })

  it('keeps user text that looks like markup inert: JSON blocks stay closed, HTML stays text', async () => {
    // The mock data has replies whose text is "Reply N </script><b>escaped?</b>".
    const { html } = await renderHtml('/ada/status/1001', { nonce: 'n' })
    const els = parse(html)
    const blocks = els.filter(
      (el) => el.name === 'script' && el.attrs.type === 'application/json' && 'data-rr' in el.attrs,
    )
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) {
      expect(b.text.toLowerCase()).not.toContain('</script')
      expect(b.text).not.toContain('<!--')
      JSON.parse(b.text)
    }
    const conversation = blocks.map((b) => JSON.parse(b.text)).find((r) => r.data?.post?.replies)
    expect(conversation.data.post.replies[0].text).toContain('</script><b>escaped?</b>')
    expect(els.some((el) => el.name === 'b' && el.text === 'escaped?')).toBe(false)
    expect(els.some((el) => el.name === 'p' && el.text.includes('</script><b>escaped?</b>'))).toBe(true)
  })

  it('crawler documents carry only JSON-LD, with "<" escaped', async () => {
    const { html } = await renderHtml('/ada/status/1001', { audience: 'crawler', nonce: 'n' })
    const scripts = parse(html).filter((el) => el.name === 'script')
    expect(scripts.map((s) => s.attrs.type)).toEqual(['application/ld+json'])
    expect(scripts[0].text).not.toContain('<')
    JSON.parse(scripts[0].text)
  })

  it('link-preview documents carry no scripts at all', async () => {
    const { html } = await renderHtml('/ada/status/1001', { audience: 'preview', nonce: 'n' })
    expect(parse(html).filter((el) => el.name === 'script')).toEqual([])
  })
})

describe('stopping a render', () => {
  // The conversation never answers on its own; it settles only when aborted.
  function hangingConversation() {
    const aborted: string[] = []
    const fetchGraphQL: FetchGraphQL = (id, variables, signal) => {
      if (operationName(id) !== 'ConversationQuery') return mockApi(id, variables, signal)
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          aborted.push('ConversationQuery')
          reject(signal.reason)
        }),
      )
    }
    return { fetchGraphQL, aborted }
  }

  it('times out pending boundaries: the stream ends, the post is there, the upstream call is cancelled', async () => {
    const { fetchGraphQL, aborted } = hangingConversation()
    const started = Date.now()
    const { status, html } = await renderHtml('/ada/status/1001', { fetchGraphQL, renderTimeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(status).toBe(200)
    expect(parse(html).filter((el) => el.name === 'article')).toHaveLength(1) // the post, no replies
    expect(aborted).toEqual(['ConversationQuery'])
  })

  it('stops when the client disconnects, cancelling upstream calls', async () => {
    const { fetchGraphQL, aborted } = hangingConversation()
    const disconnect = new AbortController()
    setTimeout(() => disconnect.abort(new Error('client disconnected')), 200)
    await renderHtml('/ada/status/1001', { fetchGraphQL, signal: disconnect.signal })
    expect(aborted).toEqual(['ConversationQuery'])
  })
})
