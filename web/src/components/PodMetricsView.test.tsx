import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PodMetricsView } from './PodMetricsView'
import { POD_METRIC_REFRESH_INTERVAL_MS, type PodMetricsSnapshot } from '../podMetrics'

class MockEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  close() {
    this.closed = true
  }
}

function snapshot(pods: PodMetricsSnapshot['pods'], retrievedAt = new Date().toISOString()): PodMetricsSnapshot {
  return {
    namespace: 'team-a',
    retrievedAt,
    pods,
    warnings: [],
  }
}

function pod(name: string, index = 0): PodMetricsSnapshot['pods'][number] {
  return {
    name,
    timestamp: new Date(Date.now() - 15_000).toISOString(),
    window: '30s',
    cpuMilliCores: 125 + index * 25,
    memoryBytes: (32 + index * 8) * 1024 * 1024,
  }
}

function response(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
  } as Response
}

describe('PodMetricsView', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows separate CPU and memory charts and current metrics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot([pod('api', 0), pod('worker', 1)])))
    vi.stubGlobal('fetch', fetchMock)
    render(<PodMetricsView ctx="dev/team" />)

    expect(await screen.findByRole('img', { name: 'CPU usage history by pod' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Memory usage history by pod' })).toBeInTheDocument()
    expect(await screen.findByRole('row', { name: /api/ })).toHaveTextContent('125m')
    expect(screen.getByRole('row', { name: /worker/ })).toHaveTextContent('150m')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Graph api' })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: 'Graph worker' })).toBeChecked()
    expect(fetchMock).toHaveBeenCalledWith('/api/pod-metrics/dev%2Fteam', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="cpu-metrics-chart"] path[d^="M"]')).toHaveLength(2)
      expect(document.querySelectorAll('[data-testid="memory-metrics-chart"] path[d^="M"]')).toHaveLength(2)
    })
  })

  it('keeps every pod available and requires explicit chart selection for large namespaces', async () => {
    const pods = Array.from({ length: 10 }, (_, index) => pod(`pod-${index}`, index))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(snapshot(pods))))
    render(<PodMetricsView ctx="dev" />)

    expect(await screen.findByText(/All reported pods remain in the table/)).toBeInTheDocument()
    await screen.findByRole('row', { name: /pod-9/ })
    expect(screen.getAllByRole('row')).toHaveLength(11)
    expect(screen.getByRole('checkbox', { name: 'Graph pod-0' })).not.toBeChecked()
    expect(screen.getByText('0 of up to 8 chart series selected · 10 pods reported')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'CPU usage history by pod' })).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('checkbox', { name: 'Graph pod-0' }).click()
    })
    expect(screen.getByRole('checkbox', { name: 'Graph pod-0' })).toBeChecked()
    expect(screen.getByText('1 of up to 8 chart series selected · 10 pods reported')).toBeInTheDocument()
  })

  it('shows empty metrics and incomplete values without inventing zeroes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(snapshot([
      { ...pod('partial'), cpuMilliCores: null },
    ]))))
    render(<PodMetricsView ctx="dev" />)

    const row = await screen.findByRole('row', { name: /partial/ })
    expect(row).toHaveTextContent('—')
    expect(row).toHaveTextContent('32 MiB')
  })

  it('explains an empty namespace and surfaces metrics API errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([])))
      .mockResolvedValueOnce(response({ error: 'The Pod Metrics API is unavailable.' }, false, 503))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<PodMetricsView ctx="dev" />)

    expect(await screen.findByText(/No pod metrics are available in namespace team-a/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'CPU usage history by pod' })).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Refresh pod metrics' }).click()
    })
    expect(await screen.findByText(/The Pod Metrics API is unavailable/)).toBeInTheDocument()

    rerender(<PodMetricsView ctx="" />)
    expect(screen.getByText('Select a Kubernetes context to load pod metrics.')).toBeInTheDocument()
  })

  it('auto-selects after an empty initial snapshot without overriding a deliberate clear', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([])))
      .mockResolvedValueOnce(response(snapshot([pod('api')])))
      .mockResolvedValueOnce(response(snapshot([pod('api', 2)])))
    vi.stubGlobal('fetch', fetchMock)
    render(<PodMetricsView ctx="dev" />)

    expect(await screen.findByText(/No pod metrics are available in namespace team-a/)).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh pod metrics' }).click()
    })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Graph api' })).toBeChecked())

    await act(async () => {
      screen.getByRole('button', { name: 'Clear chart selection' }).click()
    })
    expect(screen.getByRole('checkbox', { name: 'Graph api' })).not.toBeChecked()
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh pod metrics' }).click()
    })
    await waitFor(() => {
      expect(screen.getByRole('row', { name: /api/ })).toHaveTextContent('175m')
      expect(screen.getByRole('checkbox', { name: 'Graph api' })).not.toBeChecked()
    })
    expect(screen.getByText('0 of up to 8 chart series selected · 1 pods reported')).toBeInTheDocument()
  })

  it('prunes removed pods from chart selection and history on replacement snapshots', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([pod('api'), pod('worker', 1)])))
      .mockResolvedValueOnce(response(snapshot([pod('worker', 1)])))
    vi.stubGlobal('fetch', fetchMock)
    render(<PodMetricsView ctx="dev" />)

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Graph api' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Graph worker' })).toBeChecked()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh pod metrics' }).click()
    })
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: 'Graph api' })).not.toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'Graph worker' })).toBeChecked()
      expect(document.querySelectorAll('[data-testid="cpu-metrics-chart"] path[d^="M"]')).toHaveLength(1)
    })
    expect(screen.getByText('1 of up to 8 chart series selected · 1 pods reported')).toBeInTheDocument()
  })

  it('breaks chart lines when source timestamps skip beyond the metrics window', async () => {
    const firstTimestamp = Date.now() - 3 * 60_000
    const first = { ...pod('api'), timestamp: new Date(firstTimestamp).toISOString(), window: '30s' }
    const later = { ...pod('api'), timestamp: new Date(firstTimestamp + 90_000).toISOString(), window: '30s' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([first])))
      .mockResolvedValueOnce(response(snapshot([later])))
    vi.stubGlobal('fetch', fetchMock)
    render(<PodMetricsView ctx="dev" />)

    await waitFor(() => {
      const path = document.querySelector('[data-testid="cpu-metrics-chart"] path')
      expect(path?.getAttribute('d')?.match(/M /g)).toHaveLength(1)
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Refresh pod metrics' }).click()
    })
    await waitFor(() => {
      const path = document.querySelector('[data-testid="cpu-metrics-chart"] path')
      expect(path?.getAttribute('d')?.match(/M /g)).toHaveLength(2)
    })
  })

  it('updates sample ages and stale warnings when polling stops succeeding', async () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-11-06T06:00:00Z')
    vi.setSystemTime(now)
    const sample = {
      ...pod('api'),
      timestamp: new Date(now - 59_000).toISOString(),
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot([sample], new Date(now).toISOString())))
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(<PodMetricsView ctx="dev" />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('59s ago')).toBeInTheDocument()
    expect(screen.queryByText(/older than one minute/)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POD_METRIC_REFRESH_INTERVAL_MS)
    })
    expect(screen.getByText('1m ago')).toBeInTheDocument()
    expect(screen.getByText(/older than one minute/)).toBeInTheDocument()
    expect(screen.getByText(/offline/)).toBeInTheDocument()

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
