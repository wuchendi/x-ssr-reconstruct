import type { GraphQLResponse, RequestParameters } from 'relay-runtime'
import { describe, expect, it, vi } from 'vitest'
import type { ReplaySource } from './replay-network.ts'
import { createReplayFetch } from './replay-network.ts'

const params = { id: 'op1', name: 'ProfileTimelineQuery' } as RequestParameters
const vars = { screenName: 'ada' }
const KEY = 'ProfileTimelineQuery:{"screenName":"ada"}'
const RESPONSE: GraphQLResponse = { data: { ok: true } }

function source(
  initial: Record<string, string> = {},
): ReplaySource & { arrive(key: string, text: string): void; end(): void; waiting(): number } {
  const m = new Map(Object.entries(initial))
  const w = new Map<string, Set<() => void>>()
  let ended = false
  return {
    take: (k) => {
      const t = m.get(k)
      m.delete(k)
      return t
    },
    get ended() {
      return ended
    },
    wait(k, fn) {
      const set = w.get(k) ?? new Set()
      set.add(fn)
      w.set(k, set)
      return () => set.delete(fn)
    },
    arrive(k, text) {
      m.set(k, text)
      for (const fn of w.get(k) ?? []) fn()
    },
    end() {
      ended = true
      for (const set of w.values()) for (const fn of set) fn()
    },
    waiting: () => [...w.values()].reduce((n, s) => n + s.size, 0),
  }
}

function run(fetchFn: ReturnType<typeof createReplayFetch>) {
  const events: Array<{ next?: unknown; error?: string; complete?: true }> = []
  const sub = fetchFn(params, vars).subscribe({
    next: (v) => events.push({ next: v }),
    error: (e: Error) => events.push({ error: e.message }),
    complete: () => events.push({ complete: true }),
  })
  return { events, sub }
}

describe('createReplayFetch', () => {
  it('replays a response the server already streamed, without calling the API', () => {
    const api = vi.fn()
    const { events } = run(
      createReplayFetch({ source: source({ [KEY]: JSON.stringify(RESPONSE) }), api, timeoutMs: 1000 }),
    )
    expect(events).toEqual([{ next: RESPONSE }, { complete: true }])
    expect(api).not.toHaveBeenCalled()
  })

  it('waits for a response still on its way down the stream', () => {
    const src = source()
    const api = vi.fn()
    const { events } = run(createReplayFetch({ source: src, api, timeoutMs: 1000 }))
    expect(events).toEqual([])
    src.arrive(KEY, JSON.stringify(RESPONSE))
    expect(events).toEqual([{ next: RESPONSE }, { complete: true }])
    expect(api).not.toHaveBeenCalled()
  })

  it('asks the API when the stream ended without that response', async () => {
    const src = source()
    const api = vi.fn().mockResolvedValue(RESPONSE)
    const { events } = run(createReplayFetch({ source: src, api, timeoutMs: 1000 }))
    src.end()
    await vi.waitFor(() => expect(events).toEqual([{ next: RESPONSE }, { complete: true }]))
    expect(api).toHaveBeenCalledWith('op1', 'ProfileTimelineQuery', vars, expect.any(AbortSignal))
  })

  // dispose() on a PreloadedQuery unsubscribes: that must really cancel.
  it('unsubscribing while waiting removes the waiter: no API call when the stream ends', () => {
    const src = source()
    const api = vi.fn()
    const { sub } = run(createReplayFetch({ source: src, api, timeoutMs: 1000 }))
    expect(src.waiting()).toBe(1)
    sub.unsubscribe()
    expect(src.waiting()).toBe(0)
    src.end()
    expect(api).not.toHaveBeenCalled()
  })

  it('unsubscribing during the API call aborts the fetch', () => {
    let signal: AbortSignal | undefined
    const api = vi.fn((_id, _name, _vars, s: AbortSignal) => {
      signal = s
      return new Promise<GraphQLResponse>(() => {})
    })
    const src = source()
    src.end()
    const { sub } = run(createReplayFetch({ source: src, api, timeoutMs: 1000 }))
    expect(signal?.aborted).toBe(false)
    sub.unsubscribe()
    expect(signal?.aborted).toBe(true)
  })

  it('fails the request when the API call times out', async () => {
    const api = vi.fn(
      (_id, _name, _vars, s: AbortSignal) =>
        new Promise<GraphQLResponse>((_, reject) => s.addEventListener('abort', () => reject(s.reason))),
    )
    const src = source()
    src.end()
    const { events } = run(createReplayFetch({ source: src, api, timeoutMs: 20 }))
    await vi.waitFor(() => expect(events).toEqual([{ error: expect.stringMatching(/timed out/i) }]))
  })

  it('fails when the API answers with errors and no root data (an error bubbled to the root)', async () => {
    const api = vi
      .fn()
      .mockResolvedValue({ data: { user: null }, errors: [{ message: 'boom', path: ['user', 'posts'] }] })
    const src = source()
    src.end()
    const { events } = run(createReplayFetch({ source: src, api, timeoutMs: 1000 }))
    await vi.waitFor(() =>
      expect(events).toEqual([{ error: expect.stringMatching(/ProfileTimelineQuery failed: boom/) }]),
    )
  })
})
