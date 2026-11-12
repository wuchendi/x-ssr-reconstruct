// Load test: SSR throughput, latency, TTFB and event-loop utilisation, with
// 1 vs N Watt workers. Run after `pnpm build` (Linux: reads /proc for CPU).
//   node apps/web/scripts/load-test.mjs
//   LOAD_WORKERS=1,2,4 LOAD_DURATION=15 LOAD_CONNECTIONS=64 node apps/web/scripts/load-test.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import autocannon from 'autocannon'

const WORKERS = (process.env.LOAD_WORKERS ?? '1,4').split(',').map(Number)
const DURATION = Number(process.env.LOAD_DURATION ?? 10)
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 32)
const WEB_PORT = 3330
const API_PORT = 3332
const METRICS_PORT = 9330
const API_PROCESSES = 4
const webDir = new URL('..', import.meta.url).pathname
const apiDir = new URL('../../api', import.meta.url).pathname
const BASE = `http://127.0.0.1:${WEB_PORT}`
const ENCODING = { 'accept-encoding': 'br, gzip' } // like a browser: compression is part of the cost

// latency 0: the mock API answers instantly, so rendering is what's measured.
// latency 1: the mock's real latencies (60-650 ms): TTFB vs full response.
const SCENARIOS = [
  { latency: 0, name: 'person /ada', path: '/ada', headers: {} },
  { latency: 0, name: 'crawler /ada', path: '/ada', headers: { 'x-edge-verified-bot': 'search' } },
  { latency: 0, name: 'person /ada/status/1001', path: '/ada/status/1001', headers: {} },
  { latency: 1, name: 'person /ada, real latency', path: '/ada', headers: {} },
]

// LOAD_UPSTREAM_TIMEOUT_MS: the web server's timeout for API calls (default
// 1000). Below the observed event-loop stalls, false timeouts appear.
const UPSTREAM_TIMEOUT = process.env.LOAD_UPSTREAM_TIMEOUT_MS
// LOAD_ONLY=substring: run only the scenarios whose name contains it.
const ONLY = process.env.LOAD_ONLY
const RUN = SCENARIOS.filter((s) => !ONLY || s.name.includes(ONLY))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim())

function start(cmd, args, cwd, env, logFile) {
  const out = logFile ? openSync(logFile, 'w') : 'ignore'
  return spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out] })
}

// Degradation is invisible in status codes: a section whose upstream call
// fails after the shell is handed to the browser and the response is still
// 200. Count it in the web server's log instead.
const WEB_LOG = `${webDir}.tmp/load-web.log`
const logSize = () => {
  try {
    return statSync(WEB_LOG).size
  } catch {
    return 0
  }
}
function logSince(offset) {
  const text = readFileSync(WEB_LOG).subarray(offset).toString()
  const lines = text.split('\n')
  return {
    // Clients the load generator cut off at the end of a run are not degradation.
    boundaryErrors: lines.filter((l) => l.includes('render error after shell') && !l.includes('client disconnected'))
      .length,
    upstreamTimeouts: lines.filter((l) => /render error after shell|request failed/.test(l) && /timeout/i.test(l))
      .length,
  }
}
async function stop(child) {
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(-child.pid, 0)
    } catch {
      return
    }
    await sleep(100)
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const res = await fetch(url)
      await res.arrayBuffer()
      if (res.ok) return
    } catch {}
    await sleep(300)
  }
  throw new Error(`not ready: ${url}`)
}

// CPU seconds used by a process tree (Watt runs its workers as threads).
function descendants(pid) {
  let out = [pid]
  try {
    for (const c of execFileSync('pgrep', ['-P', String(pid)])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)) {
      out = out.concat(descendants(Number(c)))
    }
  } catch {}
  return out
}
function cpuSeconds(rootPid) {
  let ticks = 0
  for (const pid of descendants(rootPid)) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
      ticks += Number(fields[11]) + Number(fields[12]) // utime + stime
    } catch {}
  }
  return ticks / CLK_TCK
}

// Per web worker: event-loop utilisation, and the longest event-loop delay
// (a long synchronous stall is what turns into false upstream timeouts).
async function loopSample() {
  try {
    const text = await (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text()
    const values = (name) =>
      [...text.matchAll(new RegExp(`^${name}\\{applicationId="web"[^}]*\\} ([\\d.e+-]+)$`, 'gm'))].map((m) =>
        Number(m[1]),
      )
    return { elu: values('nodejs_eventloop_utilization'), lagMax: values('nodejs_eventloop_lag_max_seconds') }
  } catch {
    return { elu: [], lagMax: [] }
  }
}

function ttfbOnce(path, headers) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const req = get(`${BASE}${path}`, { headers: { ...ENCODING, ...headers } }, (res) => {
      const ms = performance.now() - t0
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200 ? ms : null))
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10_000, () => req.destroy())
  })
}

const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function measure(scenario, webPid, apiPid) {
  const opts = {
    url: `${BASE}${scenario.path}`,
    connections: CONNECTIONS,
    headers: { ...ENCODING, ...scenario.headers },
  }
  await autocannon({ ...opts, duration: 2 }) // warm-up

  let running = true
  const ttfb = []
  const elu = []
  const lag = []
  const probe = (async () => {
    while (running) {
      const ms = await ttfbOnce(scenario.path, scenario.headers)
      if (ms !== null) ttfb.push(ms)
      await sleep(100)
    }
  })()
  const sampler = (async () => {
    while (running) {
      const s = await loopSample()
      if (s.elu.length) elu.push(s.elu)
      lag.push(...s.lagMax)
      await sleep(1000)
    }
  })()
  const log0 = logSize()
  const cpu0 = { web: cpuSeconds(webPid), api: cpuSeconds(apiPid), t: performance.now() }
  const r = await autocannon({ ...opts, duration: DURATION })
  const secs = (performance.now() - cpu0.t) / 1000
  const cpu = { web: (cpuSeconds(webPid) - cpu0.web) / secs, api: (cpuSeconds(apiPid) - cpu0.api) / secs }
  running = false
  await Promise.all([probe, sampler])
  await sleep(200) // let the last log lines land
  const log = logSince(log0)

  const eluMean = elu.length ? elu.reduce((n, s) => n + s.reduce((a, b) => a + b, 0) / s.length, 0) / elu.length : null
  const eluMax = elu.length ? Math.max(...elu.flat()) : null
  return {
    rps: r.requests.average,
    p50: r.latency.p50,
    p90: r.latency.p90,
    p99: r.latency.p99,
    ttfbP50: pct(ttfb, 50),
    ttfbP95: pct(ttfb, 95),
    non2xx: r.non2xx,
    errors: r.errors + r.timeouts,
    degraded: log.boundaryErrors,
    upstreamTimeouts: log.upstreamTimeouts,
    eluMean,
    eluMax,
    lagMaxMs: lag.length ? Math.max(...lag) * 1000 : null,
    webCores: cpu.web,
    apiCores: cpu.api,
  }
}

mkdirSync(`${webDir}.tmp`, { recursive: true })
const results = []
for (const latency of [...new Set(RUN.map((s) => s.latency))]) {
  const api = start('node', ['scripts/cluster.mjs'], apiDir, {
    PORT: String(API_PORT),
    API_PROCESSES: String(API_PROCESSES),
    MOCK_LATENCY_SCALE: String(latency),
    LOG_LEVEL: 'warn',
  })
  await waitFor(`http://127.0.0.1:${API_PORT}/i/api/flags`)
  for (const workers of WORKERS) {
    writeFileSync(
      `${webDir}.tmp/watt.load.json`,
      JSON.stringify({
        $schema: 'https://schemas.platformatic.dev/@platformatic/runtime/3.78.0.json',
        entrypoint: 'web',
        applications: [{ id: 'web', path: '../server' }],
        server: { hostname: '127.0.0.1', port: WEB_PORT },
        workers,
        metrics: { port: METRICS_PORT, hostname: '127.0.0.1' },
        logger: { level: 'warn' },
      }),
    )
    const web = start(
      'pnpm',
      ['exec', 'wattpm', 'start', '-c', '.tmp/watt.load.json'],
      webDir,
      { API_URL: `http://127.0.0.1:${API_PORT}`, LOG_LEVEL: 'warn', UPSTREAM_TIMEOUT_MS: UPSTREAM_TIMEOUT ?? '1000' },
      WEB_LOG,
    )
    await waitFor(`${BASE}/ada`)
    for (const scenario of RUN.filter((s) => s.latency === latency)) {
      const m = await measure(scenario, web.pid, api.pid)
      results.push({ workers, scenario: scenario.name, ...m })
      console.log(`done: ${workers} worker(s), ${scenario.name}: ${m.rps.toFixed(0)} req/s`)
    }
    await stop(web)
  }
  await stop(api)
}

writeFileSync(`${webDir}.tmp/load-results.json`, JSON.stringify(results, null, 2))
const f = (x, d = 0) => (x == null ? '-' : x.toFixed(d))
console.log(
  `\n${CONNECTIONS} connections, ${DURATION}s per run, upstream timeout ${UPSTREAM_TIMEOUT ?? 1000} ms, br/gzip accepted, API on ${API_PROCESSES} processes, ${execFileSync('nproc').toString().trim()} CPUs (load generator on the same machine)\n`,
)
console.log(
  '| workers | scenario | req/s | p50 ms | p90 ms | p99 ms | TTFB p50 | TTFB p95 | non-2xx | errors | degraded | upstream timeouts | ELU mean | ELU max | loop lag max ms | web cores | API cores |',
)
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  console.log(
    `| ${r.workers} | ${r.scenario} | ${f(r.rps)} | ${f(r.p50)} | ${f(r.p90)} | ${f(r.p99)} | ${f(r.ttfbP50)} | ${f(r.ttfbP95)} | ${r.non2xx} | ${r.errors} | ${r.degraded} | ${r.upstreamTimeouts} | ${f(r.eluMean, 2)} | ${f(r.eluMax, 2)} | ${f(r.lagMaxMs)} | ${f(r.webCores, 1)} | ${f(r.apiCores, 1)} |`,
  )
}
