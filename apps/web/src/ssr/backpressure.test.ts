// A slow client must slow React down, not make the server buffer the page.
// React pauses when destination.write() returns false and resumes on
// 'drain'; the injector has to pass that signal through.
import { createElement, Suspense, use } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResponseInjector } from './inject.ts'

const BOUNDARIES = 300
const BOUNDARY_BYTES = 5_000

// A page of many Suspense boundaries that all resolve right away: React
// would stream all of them (~1.5 MB) if nothing held it back.
const READY = Promise.resolve('x'.repeat(BOUNDARY_BYTES))
function Item({ i }: { i: number }) {
  return createElement('p', { id: `p${i}` }, use(READY))
}
function bigPage() {
  const items = Array.from({ length: BOUNDARIES }, (_, i) =>
    createElement(Suspense, { key: i, fallback: createElement('i', null, '…') }, createElement(Item, { i })),
  )
  return createElement('html', null, createElement('body', null, ...items))
}

const settle = () => new Promise((r) => setTimeout(r, 200))

describe('ResponseInjector backpressure', () => {
  it('stops React while the reader is behind, then streams the whole page once it reads', async () => {
    const injector = new ResponseInjector()
    let written = 0
    const write = injector.write.bind(injector)
    injector.write = ((chunk: Buffer, ...rest: unknown[]) => {
      written += chunk.length
      return write(chunk, ...(rest as []))
    }) as typeof injector.write

    const stream = renderToPipeableStream(bigPage(), {
      onShellReady() {
        stream.pipe(injector)
      },
    })

    // Nobody reads: React must stop after roughly the stream's buffer size,
    // not write the full page into memory.
    await settle()
    const writtenWhileStalled = written
    expect(writtenWhileStalled).toBeLessThan((BOUNDARIES * BOUNDARY_BYTES) / 4)

    // The reader catches up: everything arrives, complete.
    let html = ''
    for await (const chunk of injector) html += chunk
    expect(html.endsWith('</body></html>')).toBe(true)
    expect(html.match(/<p id="p\d+">/g)?.length).toBe(BOUNDARIES)
    expect(written).toBeGreaterThan(BOUNDARIES * BOUNDARY_BYTES)
  })
})
