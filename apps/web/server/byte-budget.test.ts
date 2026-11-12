import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { withByteBudget } from './byte-budget.ts'

async function drain(stream: Readable) {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

describe('withByteBudget', () => {
  it('passes the stream through unchanged', async () => {
    const out = await drain(withByteBudget(Readable.from(['<html>', 'body', '</html>']), 1000, vi.fn()))
    expect(out).toBe('<html>body</html>')
  })

  it('reports the total once when the stream ends over budget', async () => {
    const onExceed = vi.fn()
    await drain(withByteBudget(Readable.from(['x'.repeat(600), 'y'.repeat(600)]), 1000, onExceed))
    expect(onExceed).toHaveBeenCalledExactlyOnceWith(1200)
  })

  it('stays quiet under budget', async () => {
    const onExceed = vi.fn()
    await drain(withByteBudget(Readable.from(['x'.repeat(999)]), 1000, onExceed))
    expect(onExceed).not.toHaveBeenCalled()
  })

  // Fastify starts reading only after its async onSend hooks: a consumer
  // that arrives late must still get every byte.
  it('loses nothing when the consumer starts late', async () => {
    const wrapped = withByteBudget(Readable.from(['a'.repeat(10), 'b'.repeat(10)]), 1000, vi.fn())
    await new Promise((r) => setTimeout(r, 20))
    expect(await drain(wrapped)).toBe('a'.repeat(10) + 'b'.repeat(10))
  })
})
