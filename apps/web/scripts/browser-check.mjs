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
    if (r.url().includes('/i/api/graphql')) log.gql.push(JSON.parse(r.postData()).operationName)
  })
  page.on('console', (m) => m.type() === 'error' && log.errors.push(m.text()))
  page.on('pageerror', (e) => log.errors.push(String(e)))
  // Record when React first attaches to the shell's first post, and when the
  // streamed document finished parsing.
  await page.addInitScript(() => {
    const t = {}
    window.__t = t
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
    document.addEventListener('DOMContentLoaded', () => {
      t.dcl = performance.now()
    })
    const poll = () => {
      const el = document.querySelector('.post, .profile')
      if (el && Object.keys(el).some((k) => k.startsWith('__reactFiber'))) {
        t.hydrated = performance.now()
        return
      }
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  })
  if (slow) {
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    // Lighthouse "Slow 4G": 150ms RTT, 1.6 Mbps down, 750 Kbps up.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    })
  }
  const response = await page.goto(BASE + path, { waitUntil: 'load' })
  log.csp = response.headers()['content-security-policy'] ?? ''
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
  const violations = await page.evaluate(() => window.__csp)
  check(
    'A6 nonce-based CSP sent, no violations',
    /'nonce-/.test(log.csp) && violations.length === 0,
    violations.join(' | ') || log.csp.slice(0, 60),
  )
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
  check(
    'B1 no preload when a post scrolls under a still pointer',
    log.gql.length === before,
    log.gql.slice(before).join(','),
  )

  // B2. Pointer moves onto a post and dwells 100ms -> code + data preload.
  const post = page.locator('article.post').nth(3)
  const box = await post.boundingBox()
  await page.mouse.move(box.x + 40, box.y + 30)
  await page.mouse.move(box.x + 45, box.y + 32)
  await page.waitForTimeout(250)
  const pre = log.gql.slice(before)
  check(
    'B2 dwell on post preloads its route queries',
    pre.includes('PostQuery') && pre.includes('ConversationQuery'),
    pre.join(','),
  )

  // C. Click navigates client-side, reusing the preload.
  await page.evaluate(() => {
    window.__marker = 1
  })
  const n = log.gql.length
  await post.click({ position: { x: 300, y: 50 } })
  // pushState runs before React commits the transition, so the URL changes
  // first. Wait for the new route to commit (its <title>), not for posts: the
  // old profile page already has plenty. 3s is well under the slow
  // conversation upstream, so this also shows the commit doesn't wait for it.
  await page.waitForURL(/\/status\/\d+$/)
  await page.waitForFunction(() => /on X-ish/.test(document.title), null, { timeout: 3000 }).catch(() => {})
  check('C1 client-side navigation (no full reload)', await page.evaluate(() => window.__marker === 1))
  check('C2 click reused the preload (no extra GraphQL)', log.gql.length === n, log.gql.slice(n).join(','))
  check('C3 title updated on navigation', /on X-ish/.test(await page.title()), await page.title())
  await ctx.close()
}

// F. Routes with and without a primary query, both directions, incl. back
// (popstate): the head is rendered by different components per case.
{
  const { ctx, page, log } = await open('/')
  await page.evaluate(() => {
    window.__marker = 1
  })
  await page.click('a[href="/ada"]')
  await page.waitForFunction(() => document.title.startsWith('Ada'), null, { timeout: 5000 }).catch(() => {})
  await page.goBack()
  await page.waitForFunction(() => document.title === 'X-ish', null, { timeout: 5000 }).catch(() => {})
  check(
    'F1 / -> /ada -> back: titles follow, no reload, no errors',
    (await page.title()) === 'X-ish' && (await page.evaluate(() => window.__marker === 1)) && log.errors.length === 0,
    log.errors.join(' | ') || (await page.title()),
  )
  await ctx.close()
}

// G. Scroll restoration and relative timestamps.
{
  const { ctx, page, log } = await open('/ada')
  const time = page.locator('article.post time').first()
  await page
    .waitForFunction(
      () => /^\d+[smhd]$|^[A-Z][a-z]{2} \d+/.test(document.querySelector('article.post time')?.textContent ?? ''),
      null,
      { timeout: 5000 },
    )
    .catch(() => {})
  const label = await time.textContent()
  check(
    'G2 timestamps switch to relative time after hydration',
    /^\d+[smhd]$|^[A-Z][a-z]{2} \d+/.test(label ?? '') && /UTC$/.test((await time.getAttribute('title')) ?? ''),
    label,
  )

  await page.evaluate(() => window.scrollTo(0, 1200))
  await page.waitForTimeout(100)
  const post = page.locator('article.post').nth(12)
  await post.scrollIntoViewIfNeeded()
  const leftAt = await page.evaluate(() => window.scrollY)
  await post.click({ position: { x: 300, y: 50 } })
  await page.waitForFunction(() => /on X-ish/.test(document.title), null, { timeout: 5000 }).catch(() => {})
  const topAfterPush = await page.evaluate(() => window.scrollY)
  await page.goBack()
  await page.waitForFunction(() => document.title.startsWith('Ada'), null, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(200)
  const restored = await page.evaluate(() => window.scrollY)
  check(
    'G1 new page starts at the top; back restores the scroll position',
    topAfterPush === 0 && Math.abs(restored - leftAt) <= 2 && log.errors.length === 0,
    `left at ${leftAt}, after push ${topAfterPush}, restored ${restored}`,
  )
  await ctx.close()
}

// H. A streamed section whose query fails (on the server and in the browser)
// fails alone, and recovers on retry. Needs DEBUG_FAILURES=1 on the web
// server and the API (x-debug-fail makes the API answer 503).
if (process.env.DEBUG_FAILURES === '1') {
  const ctx = await browser.newContext({
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'x-debug-fail': 'ConversationQuery' },
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${BASE}/ada/status/1001`, { waitUntil: 'load' })
  await page.waitForSelector('.section-error', { timeout: 15000 }).catch(() => {})
  const sectionErrors = await page.locator('.section-error').count()
  const alerts = await page.locator('[role=alert]').count()
  const posts = await page.locator('article.post').count()
  check(
    'H1 failed replies show a section error; post and page stay',
    sectionErrors === 1 &&
      alerts === 1 &&
      posts === 1 &&
      (await page.locator('.topbar').count()) === 1 &&
      errors.length === 0,
    `section errors ${sectionErrors}, alerts ${alerts}, posts ${posts}, page errors ${errors.length}`,
  )
  await ctx.setExtraHTTPHeaders({})
  await page.locator('.section-error button').click()
  await page
    .waitForFunction(() => document.querySelectorAll('article.post').length > 1, null, { timeout: 15000 })
    .catch(() => {})
  const after = await page.locator('article.post').count()
  check(
    'H2 retry loads the replies',
    after > 1 && (await page.locator('.section-error').count()) === 0,
    `posts after retry: ${after}`,
  )
  await ctx.close()

  // H3: a 200 with GraphQL errors that nulled the root must also show the
  // section error, not an empty conversation.
  const ctx3 = await browser.newContext({
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'x-debug-fail': 'ConversationQuery:graphql' },
  })
  const page3 = await ctx3.newPage()
  await page3.goto(`${BASE}/ada/status/1001`, { waitUntil: 'load' })
  await page3.waitForSelector('.section-error', { timeout: 15000 }).catch(() => {})
  const shown = await page3.locator('.section-error').count()
  check(
    'H3 GraphQL errors that null the root show the section error',
    shown === 1 && (await page3.locator('article.post').count()) === 1,
    `section errors ${shown}`,
  )
  await ctx3.close()
}

// D. Slow 4G + slow conversation upstream: the shell hydrates long before the
// streamed document finishes parsing (async module entry).
{
  const { ctx, page, log } = await open('/ada/status/1001', { slow: true })
  await page.waitForSelector('article.post >> nth=5', { timeout: 20000 })
  const t = await page.evaluate(() => window.__t)
  check(
    'D1 shell hydrated before document finished parsing',
    t.hydrated < t.dcl,
    `hydrated=${t.hydrated?.toFixed(0)}ms dcl=${t.dcl?.toFixed(0)}ms`,
  )
  check('D2 no GraphQL request (conversation arrived in stream)', log.gql.length === 0, log.gql.join(','))
  check('D3 no errors', log.errors.length === 0, log.errors.join(' | '))
  const dViolations = await page.evaluate(() => window.__csp)
  check('D4 streamed boundaries run under CSP (no violations)', dViolations.length === 0, dViolations.join(' | '))
  const injected = await page.locator('article p b').count()
  const literal = await page.locator('article p', { hasText: '</script><b>escaped?</b>' }).count()
  check(
    'D5 markup in user text renders as text, not elements',
    injected === 0 && literal > 0,
    `b elements: ${injected}, literal: ${literal}`,
  )
  await ctx.close()
}

// E. Signed-in Home: browser-only render, fetched from the API.
{
  const { ctx, page, log } = await open('/home', { cookie: true })
  await page.waitForSelector('article.post', { timeout: 5000 }).catch(async () => {
    console.log(
      'E debug',
      JSON.stringify({ gql: log.gql, errors: log.errors, html: (await page.content()).slice(-600) }),
    )
  })
  check('E1 signed-in Home renders client-side via API', log.gql.includes('HomeTimelineQuery'), log.gql.join(','))
  const scripts = await page.evaluate(() => [...document.querySelectorAll('script[type=module]')].map((s) => s.src))
  check(
    'E2 signed-in entry used',
    scripts.some((s) => s.includes('/signed-in-')),
    scripts.join(','),
  )
  check('E3 no errors', log.errors.length === 0, log.errors.join(' | '))
  const eViolations = await page.evaluate(() => window.__csp)
  check('E4 signed-in app runs under CSP (no violations)', eViolations.length === 0, eViolations.join(' | '))
  await ctx.close()
}

await browser.close()
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
