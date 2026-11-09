import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POD_METRIC_REFRESH_INTERVAL_MS, type PodMetricsSnapshot } from '../podMetrics'
import { usePodMetrics } from './usePodMetrics'

function snapshot(namespace: string, timestamp: string): PodMetricsSnapshot {
  return {
    namespace,
    retrievedAt: timestamp,
    warnings: [],
    pods: [{
      name: 'api',
      timestamp,
      window: '30s',
      cpuMilliCores: 200,
      memoryBytes: 20 * 1024 * 1024,
    }],
  }
}

function response(data: PodMetricsSnapshot): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usePodMetrics', () => {
  it('polls without overlap and cancels polling and requests when unmounted', async () => {
    vi.useFakeTimers()
    let responseIndex = 0
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      const sample = responseIndex++
      const timestamp = new Date(Date.parse('2026-11-06T06:00:00Z') + sample * POD_METRIC_REFRESH_INTERVAL_MS).toISOString()
      return Promise.resolve(response(snapshot('team-a', timestamp)))
    })
    vi.stubGlobal('fetch', fetchMock)

    let renderCount = 0
    const { result, unmount } = renderHook(() => {
      renderCount += 1
      return usePodMetrics('dev', ['api'])
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(renderCount).toBeLessThan(10)
    expect(result.current.data?.namespace).toBe('team-a')
    expect(result.current.history.get('api')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POD_METRIC_REFRESH_INTERVAL_MS)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.history.get('api')).toHaveLength(2)
    const signal = fetchMock.mock.calls[1][1]?.signal as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the old context request and ignores its late response', async () => {
    const requests: { signal?: AbortSignal; resolve: (value: Response) => void }[] = []
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
      requests.push({ signal: init?.signal as AbortSignal | undefined, resolve })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender, unmount } = renderHook(
      ({ context }: { context: string }) => usePodMetrics(context, ['api']),
      { initialProps: { context: 'dev' } },
    )
    await waitFor(() => expect(requests).toHaveLength(1))
    const oldSignal = requests[0].signal

    rerender({ context: 'prod' })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(oldSignal?.aborted).toBe(true)
    expect(result.current.data).toBeNull()

    await act(async () => {
      requests[0].resolve(response(snapshot('dev-ns', '2026-11-06T06:00:00Z')))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.data).toBeNull()

    await act(async () => {
      requests[1].resolve(response(snapshot('prod-ns', '2026-11-06T06:00:15Z')))
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.data?.namespace).toBe('prod-ns'))
    unmount()
    expect(requests[1].signal?.aborted).toBe(true)
  })

  it('trims expired history on clock updates even when no new snapshot arrives', async () => {
    const now = Date.parse('2026-11-06T06:00:00Z')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response(snapshot('team-a', new Date(now).toISOString())),
    ))
    const { result, rerender, unmount } = renderHook(
      ({ clock }: { clock: number }) => usePodMetrics('dev', ['api'], clock),
      { initialProps: { clock: now } },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.history.get('api')).toHaveLength(1)

    rerender({ clock: now + 30 * 60_000 + 1 })
    expect(result.current.history.get('api')).toBeUndefined()
    unmount()
  })
})
