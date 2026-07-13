import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

class MockEventSource {
  static instances: MockEventSource[] = []

  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }
}

let writeTextMock: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function podEvent(uid: string, name: string, options: {
  labels?: Record<string, string>
  phase?: string
  ready?: boolean
  restarts?: number
  lastRestart?: string
} = {}) {
  const restarts = options.restarts ?? 0
  return {
    type: 'ADDED',
    object: {
      kind: 'Pod',
      metadata: {
        uid,
        name,
        namespace: 'default',
        labels: options.labels,
        creationTimestamp: '2026-07-07T23:00:00Z',
      },
      spec: {
        nodeName: 'node-a',
        containers: [{ name: 'api' }],
      },
      status: {
        phase: options.phase || 'Running',
        containerStatuses: [{
          ready: options.ready ?? true,
          restartCount: restarts,
          lastState: options.lastRestart ? { terminated: { finishedAt: options.lastRestart } } : undefined,
        }],
      },
    },
  }
}

describe('App', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('EventSource', MockEventSource)
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/version') {
        return Promise.resolve({
          json: () => Promise.resolve({
            version: '1.0.0',
            commit: 'abc123',
            date: '2026-07-08T00:00:00Z',
            latestVersion: 'v1.1.0',
            latestUrl: 'https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.1.0',
            updateAvailable: true,
          }),
        })
      }
      return Promise.resolve({
        json: () => Promise.resolve([{ name: 'dev', namespace: 'default' }]),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-08T00:00:00Z'))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders pod rows with restart age and copy feedback', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    expect(await screen.findByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Update available: v1.1.0' })).toHaveAttribute(
      'href',
      'https://github.com/davidvanlaatum/kube-watch/releases/tag/v1.1.0',
    )
    await user.selectOptions(contextSelect, 'dev')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit({
      type: 'ADDED',
      object: {
        kind: 'Pod',
        metadata: {
          uid: 'pod-1',
          name: 'api-7d9f',
          namespace: 'default',
          creationTimestamp: '2026-07-07T23:00:00Z',
        },
        spec: {
          nodeName: 'node-a',
          containers: [{ name: 'api' }],
        },
        status: {
          phase: 'Running',
          containerStatuses: [{
            ready: true,
            restartCount: 2,
            lastState: { terminated: { finishedAt: '2026-07-07T23:55:00Z' } },
          }],
        },
      },
    })

    MockEventSource.instances[0].emit({ type: 'SYNCED' })

    const row = await screen.findByRole('row', { name: /api-7d9f/ })
    expect(within(row).getByText('2 (5m ago)')).toHaveAttribute(
      'title',
      new Date('2026-07-07T23:55:00Z').toLocaleString(),
    )
    expect(within(row).getByText('1h')).toHaveAttribute(
      'title',
      new Date('2026-07-07T23:00:00Z').toLocaleString(),
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(within(row).getByText('2 (6m ago)')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Copy api-7d9f' }))

    await waitFor(() => {
      expect(within(row).getByRole('button', { name: 'Copy api-7d9f' })).toHaveTextContent('Copied')
    })
  })

  it('filters table rows by name, status, labels, restarts, and readiness', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await user.selectOptions(contextSelect, 'dev')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f', {
      labels: { app: 'api', 'app.kubernetes.io/name': 'simtool-api' },
      restarts: 2,
      lastRestart: '2026-07-07T23:55:00Z',
    }))
    MockEventSource.instances[0].emit(podEvent('pod-2', 'worker-55f8', {
      labels: { app: 'worker', 'app.kubernetes.io/name': 'simtool-worker' },
      phase: 'Pending',
      ready: false,
    }))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })

    expect(await screen.findByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /worker-55f8/ })).toBeInTheDocument()
    expect(screen.getByText('2/2 shown')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Name contains'), 'api')
    expect(screen.getByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /worker-55f8/ })).not.toBeInTheDocument()
    expect(screen.getByText('1/2 shown')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('option', { name: 'Running' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Pending' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Status equals'), 'Pending')
    expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /worker-55f8/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(document.querySelector('option[value="app.kubernetes.io/name: simtool-api"]')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Labels'), 'app.kubernetes.io/name: simtool-api')
    expect(screen.getByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /worker-55f8/ })).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Label suggestions'), 'app.kubernetes.io/name: simtool-worker')
    expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /worker-55f8/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await user.click(screen.getByLabelText('Restarts > 0'))
    expect(screen.getByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /worker-55f8/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await user.click(screen.getByLabelText('Not ready'))
    expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /worker-55f8/ })).toBeInTheDocument()
  })

  it('applies modified and deleted resource events', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await user.selectOptions(contextSelect, 'dev')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    const row = await screen.findByRole('row', { name: /api-7d9f/ })
    await user.click(row)
    expect(await screen.findByText('api-7d9f')).toBeInTheDocument()

    const modified = podEvent('pod-1', 'api-7d9f', { phase: 'Pending', ready: false })
    modified.type = 'MODIFIED'
    MockEventSource.instances[0].emit(modified)
    expect(await screen.findByRole('row', { name: /Pending/ })).toBeInTheDocument()

    const deleted = podEvent('pod-1', 'api-7d9f')
    deleted.type = 'DELETED'
    MockEventSource.instances[0].emit(deleted)

    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'YAML' })).not.toBeInTheDocument()
  })

  it('shows last seen immediately for new events ahead of the cached clock tick', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await user.selectOptions(contextSelect, 'dev')
    await user.selectOptions(resourceSelect, 'events')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2))
    const eventsStream = MockEventSource.instances.at(-1)!

    eventsStream.emit({
      type: 'ADDED',
      object: {
        kind: 'Event',
        metadata: {
          uid: 'event-1',
          name: 'api-started',
          namespace: 'default',
          creationTimestamp: '2026-07-08T00:00:01Z',
        },
        eventTime: '2026-07-08T00:00:01Z',
        type: 'Normal',
        reason: 'Started',
        involvedObject: { kind: 'Pod', name: 'api-7d9f' },
        message: 'Started container api',
      },
    })
    eventsStream.emit({ type: 'SYNCED' })

    const row = await screen.findByRole('row', { name: /Started container api/ })
    expect(within(row).getByText('0s')).toHaveAttribute(
      'title',
      new Date('2026-07-08T00:00:01Z').toLocaleString(),
    )
  })

  it('hides status filter for resources without status semantics', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await screen.findAllByRole('combobox')
    expect(screen.getByLabelText('Status equals')).toBeInTheDocument()

    await user.selectOptions(screen.getAllByRole('combobox')[1], 'services')

    expect(screen.queryByLabelText('Status equals')).not.toBeInTheDocument()
  })

  it('refreshes version status hourly', async () => {
    render(<App />)

    expect(await screen.findByText('v1.0.0')).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/version')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/version')).toHaveLength(2)
  })

  it('shows terminal stream errors and clears loading', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await user.selectOptions(contextSelect, 'dev')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    expect(screen.getByRole('status')).toHaveTextContent('Loading pods')

    MockEventSource.instances[0].emit({ error: 'namespaced initial list failed: forbidden' })

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    expect(screen.getByText('namespaced initial list failed: forbidden')).toBeInTheDocument()
  })

  it('streams logs in container tabs with pod prefixes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await user.selectOptions(contextSelect, 'dev')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit({
      type: 'ADDED',
      object: {
        kind: 'Pod',
        metadata: {
          uid: 'pod-1',
          name: 'api-7d9f',
          namespace: 'default',
          creationTimestamp: '2026-07-07T23:00:00Z',
        },
        spec: {
          nodeName: 'node-a',
          containers: [{ name: 'app' }, { name: 'sidecar' }],
        },
        status: {
          phase: 'Running',
          containerStatuses: [
            { ready: true, restartCount: 0 },
            { ready: true, restartCount: 0 },
          ],
        },
      },
    })
    MockEventSource.instances[0].emit({ type: 'SYNCED' })

    const row = await screen.findByRole('row', { name: /api-7d9f/ })
    await user.click(row)
    await user.click(screen.getByRole('button', { name: 'Logs' }))

    await waitFor(() => {
      expect(MockEventSource.instances.some(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toBe(true)
    })
    const logsStream = MockEventSource.instances.find(instance => instance.url.startsWith('/logs/'))
    expect(logsStream).toBeDefined()
    expect(screen.getByRole('button', { name: 'app' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'sidecar' })).toBeInTheDocument()
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto scroll on' })).toBeInTheDocument()

    logsStream?.emit({ info: 'connected' })
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()
    logsStream?.emit({ type: 'INFO', info: 'following logs for pod api-7d9f' })
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(6000)
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Auto scroll on' }))
    expect(screen.getByRole('button', { name: 'Auto scroll off' })).toBeInTheDocument()

    logsStream?.emit({
      type: 'LOG',
      pod: 'api-7d9f',
      container: 'app',
      timestamp: '2026-07-08T00:00:02Z',
      line: 'second',
      seq: 1,
    })
    logsStream?.emit({
      type: 'LOG',
      pod: 'api-7d9f',
      container: 'app',
      timestamp: '2026-07-08T00:00:02Z',
      line: 'second',
      seq: 2,
    })
    logsStream?.emit({
      type: 'LOG',
      pod: 'api-7d9f',
      container: 'app',
      timestamp: '2026-07-08T00:00:01Z',
      line: 'first',
      seq: 0,
    })
    logsStream?.emit({
      type: 'LOG',
      pod: 'api-7d9f',
      container: 'sidecar',
      timestamp: '2026-07-08T00:00:01Z',
      line: 'sidecar line',
      seq: 0,
    })

    const logOutput = await screen.findByLabelText('Logs for app')
    await waitFor(() => {
      expect(logOutput.textContent).toMatch(/api-7d9f: first[\s\S]*api-7d9f: second/)
    })
    expect(logOutput.textContent?.match(/api-7d9f: second/g)).toHaveLength(2)
    expect(within(logOutput).getAllByText('api-7d9f:')[0]).toHaveClass('log-pod')
    expect(logOutput).not.toHaveTextContent('sidecar line')

    await user.click(screen.getByRole('button', { name: 'sidecar' }))
    expect(await screen.findByLabelText('Logs for sidecar')).toHaveTextContent('api-7d9f: sidecar line')
  })
})
