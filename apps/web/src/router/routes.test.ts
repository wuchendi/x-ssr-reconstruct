import { describe, expect, it } from 'vitest'
import { dirToPattern, matchRoute, patternToRegex, requestPath, routes } from './routes.ts'

describe('file-based routes', () => {
  it('derives patterns from the route tree', () => {
    expect(routes.map((r) => r.pattern).sort()).toEqual(['/', '/:screenName', '/:screenName/status/:id', '/home'])
    expect(dirToPattern('[screenName]/status/[id]')).toBe('/:screenName/status/:id')
    expect(dirToPattern('_index')).toBe('/')
  })

  it('escapes regex characters in static segments', () => {
    expect(patternToRegex('/a.b').regex.test('/axb')).toBe(false)
  })
})

describe('matchRoute', () => {
  it('matches params, case-insensitively, with an optional trailing slash', () => {
    const m = matchRoute('/ADA/status/1001/', false)
    expect(m?.route.pattern).toBe('/:screenName/status/:id')
    expect(m?.params).toEqual({ screenName: 'ADA', id: '1001' })
  })

  it('prefers static segments over dynamic ones', () => {
    expect(matchRoute('/home', true)?.route.pattern).toBe('/home')
  })

  it('hides signed-in-only routes from logged-out visitors', () => {
    expect(matchRoute('/home', false)?.route.pattern).toBe('/:screenName')
  })

  it('returns null for paths the new app does not own (edge sends them to rweb)', () => {
    expect(matchRoute('/a/b/c/d', false)).toBeNull()
  })
})

describe('requestPath', () => {
  it('splits a request URL into path and query', () => {
    expect(requestPath('/ada?lang=ja')).toEqual({ pathname: '/ada', search: '?lang=ja' })
  })

  // Regression: new URL('//evil.com.', base) is protocol-relative, so the
  // path became "/" and the home page rendered with 200.
  it('keeps a leading double slash as part of the path', () => {
    expect(requestPath('//evil.com.')).toEqual({ pathname: '//evil.com.', search: '' })
    expect(matchRoute(requestPath('//evil.com.').pathname, false)).toBeNull()
  })
})
