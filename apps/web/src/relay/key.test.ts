import type { RequestParameters } from 'relay-runtime'
import { describe, expect, it } from 'vitest'
import { requestKey } from './key.ts'

const params = { name: 'ProfileTimelineQuery' } as RequestParameters

describe('requestKey', () => {
  // Server and browser build variables independently; key order must not matter.
  it('is independent of variable key order, at any depth', () => {
    expect(requestKey(params, { a: 1, b: { y: 2, x: 1 } })).toBe(requestKey(params, { b: { x: 1, y: 2 }, a: 1 }))
  })

  it('distinguishes different variables and operations', () => {
    expect(requestKey(params, { a: 1 })).not.toBe(requestKey(params, { a: 2 }))
    expect(requestKey(params, { a: 1 })).not.toBe(requestKey({ name: 'Other' } as RequestParameters, { a: 1 }))
  })

  it('keeps array order', () => {
    expect(requestKey(params, { ids: [1, 2] })).not.toBe(requestKey(params, { ids: [2, 1] }))
  })
})
