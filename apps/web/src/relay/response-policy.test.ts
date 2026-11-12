import { describe, expect, it, vi } from 'vitest'
import { checkResponse } from './response-policy.ts'

const err = (message: string, path?: string[]) => ({ message, path })

describe('checkResponse', () => {
  it('passes responses without errors through, including "not found" nulls', () => {
    const r = { data: { post: null } }
    expect(checkResponse(r, 'PostQuery')).toBe(r)
  })

  // Typical bubbling: a non-null field fails and nulls its parent, up to the root.
  it('fails an operation whose errors left no root data', () => {
    expect(() =>
      checkResponse(
        { data: { post: null }, errors: [err('replies failed', ['post', 'replies'])] },
        'ConversationQuery',
      ),
    ).toThrow(/ConversationQuery.*replies failed/)
    expect(() => checkResponse({ errors: [err('unauthenticated')] }, 'PostQuery')).toThrow(/unauthenticated/)
  })

  it('keeps partial data, and reports the errors', () => {
    const onPartial = vi.fn()
    const r = { data: { a: { id: 1 }, b: null }, errors: [err('b failed', ['b'])] }
    expect(checkResponse(r, 'Q', onPartial)).toBe(r)
    expect(onPartial).toHaveBeenCalledWith('Q', r.errors)
  })
})
