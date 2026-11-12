import type { FastifyRequest } from 'fastify'

export function parseCookies(req: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  )
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // NB: on a saturated event loop this timer can fire before an
  // already-arrived response is processed. The fix in the post was more
  // workers (lower per-loop utilisation), not a longer timeout.
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))])
}
