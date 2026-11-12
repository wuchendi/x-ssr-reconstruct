import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPersistedQueries, parsePersistedRequest } from './persisted-queries.ts'

const dirs: string[] = []
function mapFile(map: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'pq-'))
  dirs.push(dir)
  const file = join(dir, 'persisted-queries.json')
  writeFileSync(file, JSON.stringify(map))
  return { file, url: pathToFileURL(file) }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('loadPersistedQueries', () => {
  it('returns the registered query text for an id, and undefined otherwise', () => {
    const { url } = mapFile({ abc: 'query A { a }' })
    const pq = loadPersistedQueries(url, { reload: false })
    expect(pq.get('abc')).toBe('query A { a }')
    expect(pq.get('nope')).toBeUndefined()
  })

  it('does not resolve inherited object keys', () => {
    const { url } = mapFile({})
    expect(loadPersistedQueries(url, { reload: false }).get('constructor')).toBeUndefined()
  })

  it('re-reads the file on every lookup when reload is on (dev codegen)', () => {
    const { file, url } = mapFile({ a: 'query A { a }' })
    const pq = loadPersistedQueries(url, { reload: true })
    expect(pq.get('b')).toBeUndefined()
    writeFileSync(file, JSON.stringify({ a: 'query A { a }', b: 'query B { b }' }))
    expect(pq.get('b')).toBe('query B { b }')
  })
})

describe('parsePersistedRequest', () => {
  it('accepts { id, variables }', () => {
    expect(parsePersistedRequest({ id: 'abc', variables: { x: 1 } })).toEqual({ id: 'abc', variables: { x: 1 } })
  })

  it('defaults missing variables to {}', () => {
    expect(parsePersistedRequest({ id: 'abc' })).toEqual({ id: 'abc', variables: {} })
  })

  it.each([
    ['query text instead of an id', { query: '{ user(screenName: "ada") { id } }', variables: {} }],
    ['a non-string id', { id: 42 }],
    ['array variables', { id: 'abc', variables: [] }],
    ['a non-object body', 'id=abc'],
    ['null', null],
  ])('rejects %s', (_label, body) => {
    expect(parsePersistedRequest(body)).toBeNull()
  })
})
