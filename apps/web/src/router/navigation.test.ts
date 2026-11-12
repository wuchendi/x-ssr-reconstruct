import { describe, expect, it } from 'vitest'
import { createNavigationGate } from './navigation.ts'

describe('createNavigationGate', () => {
  it('lets only the latest navigation commit', () => {
    const gate = createNavigationGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  it('keeps a navigation current until another one begins', () => {
    const gate = createNavigationGate()
    const only = gate.begin()
    expect(only()).toBe(true)
    expect(only()).toBe(true)
  })
})
