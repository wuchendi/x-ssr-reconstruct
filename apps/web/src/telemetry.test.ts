import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportClientEvent } from './telemetry.ts'

afterEach(() => vi.unstubAllGlobals())

describe('reportClientEvent', () => {
  it('beacons the event with the current route, detail truncated', async () => {
    const sendBeacon = vi.fn((_url: string, _data: Blob) => true)
    vi.stubGlobal('navigator', { sendBeacon })
    vi.stubGlobal('location', { pathname: '/ada/status/1001' })
    reportClientEvent({ type: 'section-error', detail: 'x'.repeat(1000) })
    expect(sendBeacon).toHaveBeenCalledOnce()
    const [url, blob] = sendBeacon.mock.calls[0]
    expect(url).toBe('/i/api/client-events')
    expect(blob.type).toBe('application/json')
    const body = JSON.parse(await blob.text())
    expect(body).toMatchObject({ type: 'section-error', route: '/ada/status/1001' })
    expect(body.detail).toHaveLength(300)
  })

  it('never throws, even without sendBeacon', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('location', { pathname: '/' })
    expect(() => reportClientEvent({ type: 'page-error' })).not.toThrow()
  })
})
