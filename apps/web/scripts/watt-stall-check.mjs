// Verifies Watt's worker supervision: one worker's event loop is blocked (a
// "stuck render"); Watt should mark it unhealthy and replace it, while the
// other workers keep serving. Run after `pnpm build`:
//   node apps/web/scripts/watt-stall-check.mjs
import { spawn } from 'node:child_process'

const PORT = process.env.PORT ?? '3310'
const BASE = `http://127.0.0.1:${PORT}`
const t0 = performance.now()
const at = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`
const logLines = []

// The web app renders with data from the API tier: start it first.
const API_PORT = process.env.API_PORT ?? '3312'
const api = spawn('node', ['src/main.ts'], {
  cwd: new URL('../../api', import.meta.url).pathname,
  env: { ...process.env, PORT: API_PORT, LOG_LEVEL: 'warn' },
  detached: true,
})

const watt = spawn('pnpm', ['exec', 'wattpm', 'start'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT, API_URL: `http://127.0.0.1:${API_PORT}`, DEBUG_STALL_ROUTE: '1', LOG_LEVEL: 'warn' },
  detached: true,
})
for (const stream of [watt.stdout, watt.stderr]) {
  stream.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) logLines.push({ t: at(), line })
  })
}
const stop = () => {
  for (const child of [watt, api]) {
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {}
  }
}
process.on('exit', stop)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitForLog = async (re, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = logLines.find((l) => re.test(l.line))
    if (hit) return hit
    await sleep(200)
  }
  return null
}
async function probe(n, timeoutMs) {
  const results = []
  for (let i = 0; i < n; i++) {
    const s = performance.now()
    try {
      const res = await fetch(`${BASE}/ada`, { signal: AbortSignal.timeout(timeoutMs) })
      await res.arrayBuffer()
      results.push({ ok: res.status === 200, ms: performance.now() - s })
    } catch {
      results.push({ ok: false, ms: performance.now() - s })
    }
  }
  return results
}
const summary = (rs) =>
  `${rs.filter((r) => r.ok).length}/${rs.length} ok, slowest ${Math.max(...rs.map((r) => r.ms)).toFixed(0)}ms`

const ready = await waitForLog(/now listening/, 30_000)
if (!ready) {
  console.log('Watt did not start')
  process.exit(1)
}
console.log(`${at()} Watt listening (4 workers)`)
console.log(`${at()} before: ${summary(await probe(8, 3000))}`)

// Block one worker. The request never completes normally: that worker is replaced.
fetch(`${BASE}/__debug/stall?ms=120000`).catch(() => {})
await sleep(300)
console.log(`${at()} stall started on one worker`)

const during = await probe(12, 2000)
const stuck = during.filter((r) => !r.ok).length
console.log(
  `${at()} during: ${summary(during)}${stuck ? ` (${stuck} routed to the stuck worker timed out)` : ' (none routed to the stuck worker)'}`,
)

const replaced = await waitForLog(/unhealthy.*Replacing it/i, 60_000)
console.log(
  replaced
    ? `${replaced.t} Watt: ${replaced.line.replace(/^.*?(The worker)/, '$1').slice(0, 140)}`
    : 'no replacement logged',
)
await waitForLog(/Started the worker/, 1000)
await sleep(3000)

const after = await probe(16, 3000)
console.log(`${at()} after: ${summary(after)}`)

const pass = Boolean(replaced) && after.every((r) => r.ok)
console.log(pass ? 'PASS stuck worker replaced; service healthy afterwards' : 'FAIL')
stop()
await sleep(1500)
process.exit(pass ? 0 : 1)
