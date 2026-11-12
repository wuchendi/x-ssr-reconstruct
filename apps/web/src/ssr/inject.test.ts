import { describe, expect, it } from 'vitest'
import { ResponseInjector } from './inject.ts'

// Drive the injector the way React's Fizz writer does: write() any number of
// times, then flush() at the end of each flush cycle.
function run(steps: Array<{ write?: string; data?: [string, string]; flush?: true }>): string {
  const inj = new ResponseInjector()
  const out: Buffer[] = []
  inj.on('data', (c: Buffer) => out.push(c))
  for (const s of steps) {
    if (s.data) inj.pushResponse(...s.data)
    if (s.write) inj.write(s.write)
    if (s.flush) inj.flush()
  }
  inj.end()
  return Buffer.concat(out).toString()
}

const script = (key: string, json: string) =>
  `<script type="application/json" data-rr="${key}">${json}</script><script>__rr.p()</script>`

describe('ResponseInjector', () => {
  it('emits nothing between writes: splices only at flush()', () => {
    const html = run([
      { data: ['A:{}', '{"a":1}'] },
      { write: '<!DOCTYPE html><html><body><di' },
      { write: 'v>shell</div>', flush: true },
    ])
    expect(html).toBe(`<!DOCTYPE html><html><body><div>shell</div>${script('A:{}', '{"a":1}')}`)
  })

  it('puts responses after the shell, never before <!DOCTYPE html>', () => {
    const html = run([{ data: ['A:{}', '{}'] }, { write: '<!DOCTYPE html><body>shell', flush: true }])
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('puts responses before the boundary that renders them', () => {
    const html = run([
      { write: '<!DOCTYPE html><body>shell', flush: true },
      { data: ['B:{}', '{"b":2}'] },
      { write: '<div hidden id="S:0">boundary</div>', flush: true },
    ])
    expect(html.indexOf('data-rr="B:{}"')).toBeLessThan(html.indexOf('id="S:0"'))
  })

  // Regression: a shell that is the whole document (e.g. a 404 profile) used
  // to get its data appended after </html>.
  it('keeps responses inside <body> when the shell is the whole document', () => {
    const html = run([{ data: ['A:{}', '{}'] }, { write: '<!DOCTYPE html><body>404</body></html>', flush: true }])
    expect(html.endsWith(`${script('A:{}', '{}')}</body></html>`)).toBe(true)
  })

  it('escapes </script> and U+2028/2029 in response text', () => {
    const html = run([
      { write: '<!DOCTYPE html><body>', flush: true },
      { data: ['A:{}', JSON.stringify({ t: '</script><b>\u2028\u2029' })] },
      { write: 'x', flush: true },
    ])
    expect(html).not.toContain('</script><b>')
    expect(html).toContain('\\u003c/script>\\u003cb>\\u2028\\u2029')
  })

  it('escapes the key attribute', () => {
    const html = run([{ write: '<body>', flush: true }, { data: ['Q:{"s":"a\\"b<"}', '{}'] }, { write: 'x', flush: true }])
    expect(html).toContain('data-rr="Q:{&quot;s&quot;:&quot;a\\&quot;b&lt;&quot;}"')
  })
})
