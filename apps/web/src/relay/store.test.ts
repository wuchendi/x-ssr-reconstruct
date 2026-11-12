import { loadQuery } from 'react-relay'
import type { GraphQLResponse, Store } from 'relay-runtime'
import { createOperationDescriptor, Environment, Network, Observable } from 'relay-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProfileHeaderQuery from '../routes/[screenName]/__generated__/ProfileHeaderQuery.graphql.ts'
import { createClientStore, createServerStore, QUERY_CACHE_TTL_MS, RELEASE_BUFFER_SIZE } from './store.ts'

// A real Relay environment over a fake network that answers any screen name.
function setup(store: Store) {
  const fetches: string[] = []
  const network = Network.create((_params, variables) => {
    const screenName = String(variables.screenName)
    fetches.push(screenName)
    return Observable.from<GraphQLResponse>({
      data: { user: { id: `u-${screenName}`, screenName, name: screenName, bio: '', followers: 1 } },
    })
  })
  const env = new Environment({ network, store })
  const load = (screenName: string) =>
    loadQuery(env, ProfileHeaderQuery, { screenName }, { fetchPolicy: 'store-or-network' })
  const status = (screenName: string) => env.check(createOperationDescriptor(ProfileHeaderQuery, { screenName })).status
  return { env, load, status, fetches }
}
const gcTick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('client store', () => {
  it('keeps data while a PreloadedQuery retains it, however much else is released', async () => {
    const { load, status } = setup(createClientStore())
    load('kept') // never disposed
    for (let i = 0; i < RELEASE_BUFFER_SIZE * 3; i++) load(`other-${i}`).dispose()
    await gcTick()
    expect(status('kept')).toBe('available')
  })

  it('keeps the most recently released queries (back navigation), then collects older ones', async () => {
    const { load, status } = setup(createClientStore())
    for (let i = 0; i <= RELEASE_BUFFER_SIZE; i++) load(`p-${i}`).dispose()
    await gcTick()
    expect(status(`p-${RELEASE_BUFFER_SIZE}`)).toBe('available')
    expect(status('p-0')).toBe('missing')
  })

  it('treats data as stale after the cache TTL, so store-or-network refetches', () => {
    vi.useFakeTimers()
    const { load, status, fetches } = setup(createClientStore())
    load('ada')
    load('ada')
    expect(fetches).toEqual(['ada'])
    vi.setSystemTime(Date.now() + QUERY_CACHE_TTL_MS + 1)
    expect(status('ada')).toBe('stale')
    load('ada')
    expect(fetches).toEqual(['ada', 'ada'])
  })
})

describe('server store', () => {
  it('keeps nothing after release: the store lives for one request', async () => {
    const { load, status } = setup(createServerStore())
    load('ada').dispose()
    await gcTick()
    expect(status('ada')).toBe('missing')
  })
})
