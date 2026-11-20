import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMetrics } from './useMetrics'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('metrics polling', () => {
  it('preserves backend error details in the UI and browser console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'metrics unavailable: resolve deployment metrics: context deadline exceeded\n' }))
    const { result } = renderHook(() => useMetrics('dev', 'deployments'))
    await act(async () => {})
    expect(result.current.error).toBe('Metrics request failed (502): metrics unavailable: resolve deployment metrics: context deadline exceeded')
    expect(warn).toHaveBeenCalledWith('metrics request failed', expect.objectContaining({ context: 'dev', resource: 'deployments', error: expect.any(Error) }))
    warn.mockRestore()
  })
  it('polls once per view, clears failures on recovery and aborts on navigation', async () => {
    vi.useFakeTimers()
    const snapshot = { time: 123, items: {}, pods: {} }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot })
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender, unmount } = renderHook(({ ctx, resource }) => useMetrics(ctx, resource), { initialProps: { ctx: 'dev/a', resource: 'pods' } })
    await act(async () => {})
    expect(fetchMock.mock.calls[0][0]).toBe('/api/metrics/dev%2Fa/pods')
    expect(result.current.snapshot).toEqual(snapshot)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current.error).toContain('403')
    expect(result.current.snapshot).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current.error).toBeUndefined()
    const signal = fetchMock.mock.calls[0][1].signal
    rerender({ ctx: 'other', resource: 'deployments' })
    await act(async () => {})
    expect(signal.aborted).toBe(true)
    expect(fetchMock.mock.lastCall?.[0]).toBe('/api/metrics/other/deployments')
    unmount()
    const count = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(count)
  })
  it('does not fetch without a context or for unsupported resources', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = renderHook(({ ctx, resource }) => useMetrics(ctx, resource), { initialProps: { ctx: '', resource: 'pods' } })
    rerender({ ctx: 'dev', resource: 'events' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('ignores late responses from a previous context', async () => {
    let resolve!: (value: unknown) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ ok: true, json: async () => ({ time: 2, items: {}, pods: {} }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(({ ctx }) => useMetrics(ctx, 'pods'), { initialProps: { ctx: 'first' } })
    rerender({ ctx: 'second' })
    await act(async () => {})
    await act(async () => { resolve({ ok: true, json: async () => ({ time: 1 }) }) })
    expect(result.current.snapshot?.time).toBe(2)
  })
})
