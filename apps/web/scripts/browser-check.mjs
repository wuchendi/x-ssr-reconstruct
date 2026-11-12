// Runs inside the Playwright container against the prototype server.
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://station:3300'
const results = []
const check = (name, ok, detail = '') => results.push({ ok, name, detail })

const browser = await chromium.launch()

async function open(path, { cookie, slow } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' })
  if (cookie) await ctx.addCookies([{ name: 'auth_token', value: 'demo', url: BASE }])
  const page = await ctx.newPage()
  const log = { gql: [], errors: [] }
  page.on('request', (r) => {
    if (r.url().includes('/i/api/graphql')) log.gql.push(JSON.parse(r.postData()).query.match(/query (\w+)/)[1])
  })
  page.on('console', (m) => m.type() === 'error' && log.errors.push(m.text()))
  page.on('pageerror', (e) => log.errors.push(String(e)))
  // Record when React first attaches to the shell's first post, and when the
  // streamed document finished parsing.
  await page.addInitScript(() => {
    const t = (window.__t = {})
    document.addEventListener('DOMContentLoaded', () => (t.dcl = performance.now()))
    const poll = () => {
      const el = document.querySelector('.post, .profile')
      if (el && Object.keys(el).some((k) => k.startsWith('__reactFiber'))) return void (t.hydrated = performance.now())
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  })
  if (slow) {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    // Lighthouse "Slow 4G": 150ms RTT, 1.6 Mbps down, 750 Kbps up.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8,
    })
  }
  await page.goto(BASE + path, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__t.hydrated, null, { timeout: 15000 })
  return { ctx, page, log }
}

// A. Logged-out profile: hydrates from streamed responses, no API calls.
{
  const { ctx, page, log } = await open('/ada')
  await page.waitForTimeout(300)
  check('A1 profile hydrates without console/page errors', log.errors.length === 0, log.errors.join(' | '))
  check('A2 no GraphQL request at load (responses replayed)', log.gql.length === 0, log.gql.join(','))
  check('A3 20 posts rendered', (await page.locator('article.post').count()) === 20)
  check('A4 replay data scripts removed from DOM', (await page.locator('script[data-rr]').count()) === 0)
  const order = await page.evaluate(() => {
    const r = performance.getEntriesByType('resource')
    const css = r.find((e) => e.name.endsWith('.css'))
    const js = r.filter((e) => e.name.endsWith('.js'))
    return { cssEnd: css?.responseEnd, firstJsStart: Math.min(...js.map((e) => e.startTime)), jsFiles: js.length }
  })
  check('A5 JS starts only after stylesheet loaded', order.firstJsStart >= order.cssEnd, JSON.stringify(order))

  // B. Scrolling a post under a still pointer must not preload it.
  await page.mouse.move(300, 60) // over the top bar
  const before = log.gql.length
  await page.evaluate(() => window.scrollBy(0, 600))
  await page.waitForTimeout(400)
  check('B1 no preload when a post scrolls under a still pointer', log.gql.length === before, log.gql.slice(before).join(','))

  // B2. Pointer moves onto a post and dwells 100ms -> code + data preload.
  const post = page.locator('article.post').nth(3)
  const box = await post.boundingBox()
  await page.mouse.move(box.x + 40, box.y + 30)
  await page.mouse.move(box.x + 45, box.y + 32)
  await page.waitForTimeout(250)
  const pre = log.gql.slice(before)
  check('B2 dwell on post preloads its route queries', pre.includes('PostQuery') && pre.includes('ConversationQuery'), pre.join(','))

  // C. Click navigates client-side, reusing the preload.
  await page.evaluate(() => (window.__marker = 1))
  const n = log.gql.length
  await post.click({ position: { x: 300, y: 50 } })
  await page.waitForURL(/\/status\/\d+$/)
  await page.waitForSelector('article.post >> nth=1', { timeout: 5000 }).catch(() => {})
  check('C1 client-side navigation (no full reload)', await page.evaluate(() => window.__marker === 1))
  check('C2 click reused the preload (no extra GraphQL)', log.gql.length === n, log.gql.slice(n).join(','))
  check('C3 title updated on navigation', /on X-ish/.test(await page.title()), await page.title())
  await ctx.close()
}

// D. Slow 4G + slow conversation upstream: the shell hydrates long before the
// streamed document finishes parsing (async module entry).
{
  const { ctx, page, log } = await open('/ada/status/1001', { slow: true })
  await page.waitForSelector('article.post >> nth=5', { timeout: 20000 })
  const t = await page.evaluate(() => window.__t)
  check('D1 shell hydrated before document finished parsing', t.hydrated < t.dcl, `hydrated=${t.hydrated?.toFixed(0)}ms dcl=${t.dcl?.toFixed(0)}ms`)
  check('D2 no GraphQL request (conversation arrived in stream)', log.gql.length === 0, log.gql.join(','))
  check('D3 no errors', log.errors.length === 0, log.errors.join(' | '))
  await ctx.close()
}

// E. Signed-in Home: browser-only render, fetched from the API.
{
  const { ctx, page, log } = await open('/home', { cookie: true })
  await page.waitForSelector('article.post', { timeout: 5000 }).catch(async () => {
    console.log('E debug', JSON.stringify({ gql: log.gql, errors: log.errors, html: (await page.content()).slice(-600) }))
  })
  check('E1 signed-in Home renders client-side via API', log.gql.includes('HomeTimelineQuery'), log.gql.join(','))
  const scripts = await page.evaluate(() => [...document.querySelectorAll('script[type=module]')].map((s) => s.src))
  check('E2 signed-in entry used', scripts.some((s) => s.includes('/signed-in-')), scripts.join(','))
  check('E3 no errors', log.errors.length === 0, log.errors.join(' | '))
  await ctx.close()
}

await browser.close()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
