import { describe, expect, it } from 'vitest'
import { cleanPath } from './index.ts'

describe('cleanPath', () => {
  it.each([
    ['/ada.', '/ada'],
    ['/ada!?', '/ada'],
    ['/ada%E3%80%82', '/ada'], // "ada。" pasted from a CJK chat
    ['/ada/status/1001!', '/ada/status/1001'],
  ])('redirects %s to %s', (input, expected) => {
    expect(cleanPath(input)).toBe(expected)
  })

  it('returns null for clean paths', () => {
    expect(cleanPath('/ada')).toBeNull()
    expect(cleanPath('/')).toBeNull()
  })

  it('never strips a path down to the root', () => {
    expect(cleanPath('/.')).toBeNull()
  })

  it('returns null for malformed percent-encoding', () => {
    expect(cleanPath('/%E0%A4%A.')).toBeNull()
  })

  // Regression: the 301 used to target the decoded path unchecked.
  it.each(['//evil.com.', '/%2Fevil.com.', '/\\evil.com.', '/%5Cevil.com.'])('does not redirect off-origin: %s', (input) => {
    expect(cleanPath(input)).toBeNull()
  })

  it('re-encodes decoded characters for the Location header', () => {
    expect(cleanPath('/%C3%A4da.')).toBe('/%C3%A4da')
  })
})
