import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { create } from './app.ts'

let dir: string
let app: FastifyInstance

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'x-ssr-api-'))
  const file = join(dir, 'persisted-queries.json')
  writeFileSync(file, JSON.stringify({ q1: 'query Q($s: String!) { user(screenName: $s) { screenName } }' }))
  app = await create({ persistedQueries: pathToFileURL(file), reload: false, logLevel: 'silent' })
})

afterAll(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

const graphql = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/i/api/graphql', payload: body as object, headers })

describe('guest token and feature flags', () => {
  it('activates a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/i/api/1.1/guest/activate.json' })
    expect(res.statusCode).toBe(200)
    expect(res.json().guest_token).toMatch(/^gt-/)
  })

  it('returns feature flags for a country', async () => {
    const res = await app.inject('/i/api/flags?country=US')
    expect(res.json()).toMatchObject({ signup_banner: true })
  })
})

describe('persisted GraphQL', () => {
  it('runs a persisted operation with a guest token header (server-to-server)', async () => {
    const res = await graphql({ id: 'q1', variables: { s: 'ada' } }, { 'x-guest-token': 'gt-test' })
    expect(res.json()).toEqual({ data: { user: { screenName: 'ada' } } })
  })

  it('accepts the guest token cookie (browser, via the edge)', async () => {
    const res = await graphql({ id: 'q1', variables: { s: 'ada' } }, { cookie: 'gt=gt-test' })
    expect(res.json().data.user.screenName).toBe('ada')
  })

  it('refuses query text', async () => {
    const res = await graphql({ query: '{ user(screenName: "ada") { bio } }' }, { 'x-guest-token': 'gt-test' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses unknown ids', async () => {
    const res = await graphql({ id: 'nope', variables: {} }, { 'x-guest-token': 'gt-test' })
    expect(res.statusCode).toBe(400)
  })

  it('reports unauthenticated requests as GraphQL errors', async () => {
    const res = await graphql({ id: 'q1', variables: { s: 'ada' } })
    expect(res.json().errors[0].message).toBe('unauthenticated')
  })
})

describe('debug failures (test harness, off by default)', () => {
  it('ignores x-debug-fail unless enabled', async () => {
    const res = await graphql({ id: 'q1', variables: { s: 'ada' } }, { 'x-guest-token': 'gt', 'x-debug-fail': 'Q' })
    expect(res.statusCode).toBe(200)
  })

  it('fails the named operations with 503 when enabled', async () => {
    const file = join(dir, 'persisted-queries.json')
    const debug = await create({
      persistedQueries: pathToFileURL(file),
      reload: false,
      logLevel: 'silent',
      debugFailures: true,
    })
    const call = (fail: string) =>
      debug.inject({
        method: 'POST',
        url: '/i/api/graphql',
        payload: { id: 'q1', variables: { s: 'ada' } },
        headers: { 'x-guest-token': 'gt', 'x-debug-fail': fail },
      })
    expect((await call('Q')).statusCode).toBe(503)
    expect((await call('Other, Q2')).statusCode).toBe(200)
    // ":graphql": a 200 whose error bubbled up and nulled the root field.
    const bubbled = await call('Q:graphql')
    expect(bubbled.statusCode).toBe(200)
    expect(bubbled.json()).toEqual({ data: { user: null }, errors: [{ message: 'debug failure', path: ['user'] }] })
    await debug.close()
  })
})
