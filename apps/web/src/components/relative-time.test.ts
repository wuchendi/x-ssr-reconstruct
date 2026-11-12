import { describe, expect, it } from 'vitest'
import { relativeTime } from './relative-time.ts'

const now = Date.parse('2026-11-12T12:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()
const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe('relativeTime', () => {
  it.each([
    [ago(5 * S), '5s'],
    [ago(59 * S), '59s'],
    [ago(3 * M), '3m'],
    [ago(5 * H), '5h'],
    [ago(6 * D), '6d'],
  ])('formats recent times compactly: %s -> %s', (iso, label) => {
    expect(relativeTime(iso, now)).toBe(label)
  })

  it('shows a short date after a week, with the year only when it differs', () => {
    expect(relativeTime('2026-11-01T12:00:00Z', now)).toBe('Nov 1')
    expect(relativeTime('2025-03-09T12:00:00Z', now)).toBe('Mar 9, 2025')
  })

  it('treats timestamps slightly in the future (clock skew) as now', () => {
    expect(relativeTime(new Date(now + 30 * S).toISOString(), now)).toBe('0s')
  })
})
