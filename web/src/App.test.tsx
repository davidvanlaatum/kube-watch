import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

class MockEventSource {
  static instances: MockEventSource[] = []
  static backendLogInstances: MockEventSource[] = []

  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    if (url === '/api/backend-logs') {
      MockEventSource.backendLogInstances.push(this)
    } else {
      MockEventSource.instances.push(this)
    }
  }

  close() {
    this.closed = true
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  emitError() {
    this.onerror?.(new Event('error'))
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
  nodeName?: string
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
        nodeName: options.nodeName || 'node-a',
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

function helmReleaseEvent(name: string) {
  return {
    type: 'ADDED',
    object: {
      apiVersion: 'helm.sh/v3',
      kind: 'HelmRelease',
      metadata: {
        uid: `helmrelease:default:${name}`,
        name,
        namespace: 'default',
        creationTimestamp: '2026-07-07T23:00:00Z',
        labels: { status: 'deployed' },
      },
      spec: {
        chart: 'api',
        version: '1.2.3',
        appVersion: '4.5.6',
      },
      status: {
        status: 'deployed',
        revision: 2,
        updated: '2026-07-07T23:55:00Z',
        description: 'Upgrade complete',
        storageDriver: 'secrets',
      },
    },
  }
}

const helmHistoryResponse = [
  {
    revision: 1,
    status: 'superseded',
    updated: '2026-07-07T23:00:00Z',
    chart: 'api',
    version: '1.2.2',
    appVersion: '4.5.5',
    description: 'Install complete',
  },
  {
    revision: 2,
    status: 'deployed',
    updated: '2026-07-07T23:55:00Z',
    chart: 'api',
    version: '1.2.3',
    appVersion: '4.5.6',
    description: 'Upgrade complete',
  },
]

async function chooseOption(user: ReturnType<typeof userEvent.setup>, control: HTMLElement, optionName: string | RegExp) {
  await user.click(control)
  const listbox = await screen.findByRole('listbox')
  await user.click(within(listbox).getByRole('option', { name: optionName }))
}

describe('App', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    MockEventSource.instances = []
    MockEventSource.backendLogInstances = []
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
      if (url === '/api/helm-history/dev/secrets/api') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(helmHistoryResponse),
        })
      }
      return Promise.resolve({
        ok: true,
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

  it('restores context and resource from the URL route', async () => {
    window.history.replaceState(null, '', '/view/dev/events')
    render(<App />)

    expect(await screen.findByText('v1.0.0')).toBeInTheDocument()
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    expect(MockEventSource.instances[0].url).toBe('/sse/dev/events')
    expect(screen.getByRole('combobox', { name: 'Context' })).toHaveTextContent('dev')
    expect(screen.getByRole('combobox', { name: 'Resource' })).toHaveTextContent('events')
  })

  it('renders Helm releases with history details', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    window.history.replaceState(null, '', '/view/dev/helmreleases')
    render(<App />)

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    expect(MockEventSource.instances[0].url).toBe('/sse/dev/helmreleases')
    MockEventSource.instances[0].emit(helmReleaseEvent('api'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })

    const row = await screen.findByRole('row', { name: /api/ })
    expect(row).toHaveTextContent('deployed')
    expect(row).toHaveTextContent('api-1.2.3')
    expect(row).toHaveTextContent('4.5.6')
    expect(row).toHaveTextContent('2')
    await user.hover(within(row).getByText('5m'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-07T23:55:00Z').toLocaleString())
    await user.unhover(within(row).getByText('5m'))

    await user.click(row)
    await user.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('Install complete')).toBeInTheDocument()
    expect(screen.getByText('Upgrade complete')).toBeInTheDocument()
    const installHistoryRow = screen.getByRole('row', { name: /Install complete/ })
    await user.hover(within(installHistoryRow).getByText('1h'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-07T23:00:00Z').toLocaleString())
    await user.unhover(within(installHistoryRow).getByText('1h'))
    const upgradeHistoryRow = screen.getByRole('row', { name: /Upgrade complete/ })
    await user.hover(within(upgradeHistoryRow).getByText('5m'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-07T23:55:00Z').toLocaleString())
    await user.unhover(within(upgradeHistoryRow).getByText('5m'))
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/helm-history/dev/secrets/api')).toHaveLength(1)

    const modified = helmReleaseEvent('api')
    modified.type = 'MODIFIED'
    modified.object.status.description = 'Status updated'
    act(() => {
      MockEventSource.instances[0].emit(modified)
    })

    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/helm-history/dev/secrets/api')).toHaveLength(1)

    modified.object.status.revision = 3
    act(() => {
      MockEventSource.instances[0].emit(modified)
    })

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(call => call[0] === '/api/helm-history/dev/secrets/api')).toHaveLength(2)
    })
  })

  it('shows backend error logs from a single app-level stream', async () => {
    render(<App />)

    await waitFor(() => expect(MockEventSource.backendLogInstances).toHaveLength(1))
    const backendLogStream = MockEventSource.backendLogInstances[0]
    const authError = {
      type: 'BACKEND_LOG',
      error: 'Backend error: failed to build cluster config error=gcloud token expired',
      log: {
        time: '2026-07-08T00:00:00Z',
        message: 'failed to build cluster config',
      },
    }
    backendLogStream.emit(authError)

    expect(await screen.findByText('Backend error: failed to build cluster config error=gcloud token expired')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(6_000)
    backendLogStream.emit({
      ...authError,
      log: {
        time: '2026-07-08T00:00:06Z',
        message: 'failed to build cluster config',
      },
    })

    expect(await screen.findByText('Backend error: failed to build cluster config error=gcloud token expired (2x)')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(12_000)
    await waitFor(() => {
      expect(screen.queryByText(/gcloud token expired/)).not.toBeInTheDocument()
    })
  })

  it('updates the URL route when context and resource change', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    expect(window.location.pathname).toBe('/view/dev/pods')

    await chooseOption(user, resourceSelect, 'events')
    expect(window.location.pathname).toBe('/view/dev/events')
  })

  it('clears resource data and closes the stream when context is cleared', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    const resourceStream = MockEventSource.instances[0]
    resourceStream.emit(podEvent('pod-1', 'api-7d9f'))
    resourceStream.emit({ type: 'SYNCED' })
    expect(await screen.findByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()

    await chooseOption(user, contextSelect, 'Select context')

    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    })
    expect(resourceStream.closed).toBe(true)
    expect(window.location.pathname).toBe('/')
  })

  it('restores previous context and resource when navigating browser history', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await chooseOption(user, resourceSelect, 'events')
    expect(window.location.pathname).toBe('/view/dev/events')

    window.history.back()
    window.dispatchEvent(new PopStateEvent('popstate'))

    await waitFor(() => {
      expect(window.location.pathname).toBe('/view/dev/pods')
    })
    expect(screen.getByRole('combobox', { name: 'Resource' })).toHaveTextContent('pods')
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
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit({
      type: 'ADDED',
      object: {
        kind: 'Pod',
        metadata: {
          uid: 'pod-1',
          name: 'api-7d9f',
          namespace: 'default',
          creationTimestamp: '2026-07-07T23:59:01Z',
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
    await user.hover(within(row).getByText('2 (5m ago)'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-07T23:55:00Z').toLocaleString())
    await user.unhover(within(row).getByText('2 (5m ago)'))
    await user.hover(within(row).getByText('59s'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-07T23:59:01Z').toLocaleString())
    await user.unhover(within(row).getByText('59s'))
    await vi.advanceTimersByTimeAsync(1000)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(within(row).getByText('2 (6m ago)')).toBeInTheDocument()
    expect(within(row).getByText('1m')).toBeInTheDocument()

    expect(within(row).getByRole('button', { name: 'Copy api-7d9f' })).toBeInTheDocument()
  })

  it('filters table rows by name, status, labels, restarts, and readiness', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
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

    await user.click(screen.getByRole('button', { name: /NAME/ }))
    let rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('api-7d9f')
    await user.click(screen.getByRole('button', { name: /NAME/ }))
    rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('worker-55f8')

    await user.type(screen.getByLabelText('Name contains'), 'api')
    expect(screen.getByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /worker-55f8/ })).not.toBeInTheDocument()
    expect(screen.getByText('1/2 shown')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await chooseOption(user, screen.getByRole('combobox', { name: 'Status equals' }), 'Pending')
    expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /worker-55f8/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    const labelsInput = screen.getByRole('combobox', { name: 'Labels' })
    await user.type(labelsInput, 'app.kubernetes.io/name: simtool-api')
    expect(screen.getByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /worker-55f8/ })).not.toBeInTheDocument()

    await user.clear(labelsInput)
    await user.click(labelsInput)
    await user.type(labelsInput, 'worker')
    await user.click(await screen.findByRole('option', { name: 'app.kubernetes.io/name: simtool-worker' }))
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

  it('sorts by stable non-name column ids', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-alpha', 'alpha-api', { nodeName: 'node-z' }))
    MockEventSource.instances[0].emit(podEvent('pod-zeta', 'zeta-api', { nodeName: 'node-a' }))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    expect(await screen.findByRole('row', { name: /alpha-api/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /NODE/ }))

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('zeta-api')
    expect(rows[0]).toHaveTextContent('node-a')
  })

  it('applies modified and deleted resource events', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
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
    await user.click(screen.getByRole('button', { name: 'Maximize details' }))
    expect(screen.getByRole('dialog', { name: 'Pod/api-7d9f' })).toBeInTheDocument()

    const deleted = podEvent('pod-1', 'api-7d9f')
    deleted.type = 'DELETED'
    MockEventSource.instances[0].emit(deleted)

    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /api-7d9f/ })).not.toBeInTheDocument()
    })
    await vi.advanceTimersByTimeAsync(16)
    expect(document.activeElement).toBe(screen.getByRole('main'))
    expect(screen.queryByRole('button', { name: 'YAML' })).not.toBeInTheDocument()
  })

  it('keeps details state synchronized with selection, close, and deletion actions', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    const resourceStream = MockEventSource.instances[0]

    resourceStream.emit(podEvent('pod-1', 'api-7d9f'))
    resourceStream.emit(podEvent('pod-2', 'worker-55f8'))
    resourceStream.emit({ type: 'SYNCED' })

    await user.click(await screen.findByRole('row', { name: /api-7d9f/ }))
    await user.click(screen.getByRole('button', { name: 'Show full YAML' }))
    expect(screen.getByRole('button', { name: 'Hide housekeeping' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Events' }))
    expect(screen.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('row', { name: /worker-55f8/ }))
    expect(screen.getByRole('heading', { name: 'Pod/worker-55f8' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Show full YAML' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Events' }))
    const deletedApi = podEvent('pod-1', 'api-7d9f')
    deletedApi.type = 'DELETED'
    resourceStream.emit(deletedApi)
    expect(screen.getByRole('heading', { name: 'Pod/worker-55f8' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Events' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: 'YAML' }))
    await user.click(screen.getByRole('button', { name: 'Show full YAML' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('tab', { name: 'YAML' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('row', { name: /worker-55f8/ }))
    await user.click(screen.getByRole('tab', { name: 'Events' }))
    const deletedWorker = podEvent('pod-2', 'worker-55f8')
    deletedWorker.type = 'DELETED'
    resourceStream.emit(deletedWorker)

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'YAML' })).not.toBeInTheDocument()
    })
  })

  it('shows last seen immediately for new events ahead of the cached clock tick', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await chooseOption(user, resourceSelect, 'events')
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
    await user.hover(within(row).getByText('0s'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-08T00:00:01Z').toLocaleString())
  })

  it('resets stale table sorting when switching resources', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    expect(await screen.findByRole('row', { name: /api-7d9f/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /NODE/ }))
    await chooseOption(user, resourceSelect, 'events')
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2))
    const eventsStream = MockEventSource.instances.at(-1)!

    eventsStream.emit({
      type: 'ADDED',
      object: {
        kind: 'Event',
        metadata: { uid: 'event-old', name: 'old', namespace: 'default', creationTimestamp: '2026-07-07T23:50:00Z' },
        eventTime: '2026-07-07T23:50:00Z',
        type: 'Normal',
        reason: 'Old',
        involvedObject: { kind: 'Pod', name: 'api-7d9f' },
        message: 'older event',
      },
    })
    eventsStream.emit({
      type: 'ADDED',
      object: {
        kind: 'Event',
        metadata: { uid: 'event-new', name: 'new', namespace: 'default', creationTimestamp: '2026-07-07T23:59:00Z' },
        eventTime: '2026-07-07T23:59:00Z',
        type: 'Normal',
        reason: 'New',
        involvedObject: { kind: 'Pod', name: 'api-7d9f' },
        message: 'newer event',
      },
    })
    eventsStream.emit({ type: 'SYNCED' })

    await waitFor(() => {
      const rows = screen.getAllByRole('row')
      expect(rows[1]).toHaveTextContent('newer event')
    })
  })

  it('hides status filter for resources without status semantics', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    await screen.findAllByRole('combobox')
    expect(screen.getByLabelText('Status equals')).toBeInTheDocument()

    await chooseOption(user, screen.getByRole('combobox', { name: 'Resource' }), 'services')

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
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    expect(screen.getByRole('status')).toHaveTextContent('Loading pods')

    MockEventSource.instances[0].emit({ error: 'namespaced initial list failed: forbidden' })

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    expect(screen.getByText('namespaced initial list failed: forbidden')).toBeInTheDocument()
  })

  it('clears selected event stream reconnect errors after recovery sync', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    await user.click(await screen.findByRole('row', { name: /api-7d9f/ }))
    await waitFor(() => expect(MockEventSource.instances.some(instance => instance.url === '/sse/dev/events')).toBe(true))
    const eventStream = MockEventSource.instances.find(instance => instance.url === '/sse/dev/events')!

    eventStream.emitError()
    await user.click(screen.getByRole('tab', { name: 'Events' }))
    expect(await screen.findByText('Event stream interrupted; waiting for EventSource to reconnect')).toBeInTheDocument()

    eventStream.emit({ type: 'SYNCED' })

    await waitFor(() => {
      expect(screen.queryByText('Event stream interrupted; waiting for EventSource to reconnect')).not.toBeInTheDocument()
    })
  })

  it('renders selected resource events in the details drawer', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    await user.click(await screen.findByRole('row', { name: /api-7d9f/ }))
    await waitFor(() => expect(MockEventSource.instances.some(instance => instance.url === '/sse/dev/events')).toBe(true))
    const eventStream = MockEventSource.instances.find(instance => instance.url === '/sse/dev/events')!
    const eventStreamCount = MockEventSource.instances.filter(instance => instance.url === '/sse/dev/events').length

    eventStream.emit({
      type: 'ADDED',
      object: {
        kind: 'Event',
        metadata: {
          uid: 'event-1',
          name: 'api-pulled',
          namespace: 'default',
          creationTimestamp: '2026-07-08T00:00:01Z',
        },
        eventTime: '2026-07-08T00:00:01Z',
        type: 'Normal',
        reason: 'Pulled',
        involvedObject: { uid: 'pod-1', kind: 'Pod', name: 'api-7d9f', namespace: 'default' },
        message: 'Successfully pulled image',
      },
    })
    eventStream.emit({ type: 'SYNCED' })
    await user.click(screen.getByRole('tab', { name: 'Events' }))

    const eventRow = await screen.findByRole('row', { name: /Successfully pulled image/ })
    expect(eventRow).toHaveTextContent('Pod/api-7d9f')
    await user.hover(within(eventRow).getByText('0s'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(new Date('2026-07-08T00:00:01Z').toLocaleString())
    await user.unhover(within(eventRow).getByText('0s'))

    const modifiedPod = podEvent('pod-1', 'api-7d9f', { phase: 'Pending', ready: false })
    modifiedPod.type = 'MODIFIED'
    act(() => {
      MockEventSource.instances[0].emit(modifiedPod)
    })

    expect(MockEventSource.instances.filter(instance => instance.url === '/sse/dev/events')).toHaveLength(eventStreamCount)
    expect(eventStream.closed).toBe(false)
  })

  it('streams logs in container tabs with pod prefixes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
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
    await user.click(screen.getByRole('tab', { name: 'Logs' }))
    await user.click(screen.getByRole('button', { name: 'Maximize details' }))
    expect(screen.getByRole('button', { name: 'Restore details size' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Pod/api-7d9f' })).toBeInTheDocument()
    expect(document.querySelector('.details-panel-maximized')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore details size' }))
    expect(screen.getByRole('button', { name: 'Maximize details' })).toBeInTheDocument()

    await waitFor(() => {
      expect(MockEventSource.instances.some(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toBe(true)
    })
    let logsStream = MockEventSource.instances.find(instance => instance.url.startsWith('/logs/'))
    expect(logsStream).toBeDefined()
    expect(screen.getByRole('tab', { name: 'app' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'sidecar' })).toBeInTheDocument()
    expect(screen.getByText('Loading logs...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto scroll on' })).toBeInTheDocument()

    const statusOnlyPod = podEvent('pod-1', 'api-7d9f', { phase: 'Pending', ready: false })
    statusOnlyPod.type = 'MODIFIED'
    statusOnlyPod.object.spec.containers = [{ name: 'app' }, { name: 'sidecar' }]
    act(() => {
      MockEventSource.instances[0].emit(statusOnlyPod)
    })

    expect(MockEventSource.instances.filter(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toHaveLength(1)
    expect(logsStream?.closed).toBe(false)

    const modifiedPod = podEvent('pod-1', 'api-7d9f')
    modifiedPod.type = 'MODIFIED'
    modifiedPod.object.spec.containers = [{ name: 'app' }, { name: 'sidecar' }, { name: 'debug' }]
    act(() => {
      MockEventSource.instances[0].emit(modifiedPod)
    })

    await waitFor(() => {
      expect(MockEventSource.instances.filter(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toHaveLength(2)
    })
    expect(logsStream?.closed).toBe(true)
    logsStream = MockEventSource.instances.filter(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200').at(-1)
    expect(screen.getByRole('tab', { name: 'debug' })).toBeInTheDocument()

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

    await user.click(screen.getByRole('tab', { name: 'sidecar' }))
    expect(await screen.findByLabelText('Logs for sidecar')).toHaveTextContent('api-7d9f: sidecar line')
  })

  it('reconnects deployment logs when template containers change', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect, resourceSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await chooseOption(user, resourceSelect, 'deployments')
    await waitFor(() => expect(MockEventSource.instances.some(instance => instance.url === '/sse/dev/deployments')).toBe(true))
    const deploymentStream = MockEventSource.instances.find(instance => instance.url === '/sse/dev/deployments')!

    const deployment = {
      type: 'ADDED',
      object: {
        kind: 'Deployment',
        metadata: {
          uid: 'deployment-1',
          name: 'api',
          namespace: 'default',
          creationTimestamp: '2026-07-07T23:00:00Z',
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [{ name: 'app' }],
            },
          },
        },
        status: {
          readyReplicas: 1,
          updatedReplicas: 1,
          availableReplicas: 1,
        },
      },
    }
    deploymentStream.emit(deployment)
    deploymentStream.emit({ type: 'SYNCED' })
    await user.click(await screen.findByRole('row', { name: /api/ }))
    await user.click(screen.getByRole('tab', { name: 'Logs' }))
    await waitFor(() => {
      expect(MockEventSource.instances.filter(instance => instance.url === '/logs/dev/deployments/default/api?tailLines=200')).toHaveLength(1)
    })
    const logsStream = MockEventSource.instances.find(instance => instance.url === '/logs/dev/deployments/default/api?tailLines=200')!

    const modifiedDeployment = structuredClone(deployment)
    modifiedDeployment.type = 'MODIFIED'
    modifiedDeployment.object.spec.template.spec.containers = [{ name: 'app' }, { name: 'debug' }]
    act(() => {
      deploymentStream.emit(modifiedDeployment)
    })

    await waitFor(() => {
      expect(MockEventSource.instances.filter(instance => instance.url === '/logs/dev/deployments/default/api?tailLines=200')).toHaveLength(2)
    })
    expect(logsStream.closed).toBe(true)
    expect(screen.getByRole('tab', { name: 'debug' })).toBeInTheDocument()
  })

  it('clears log stream reconnect errors after recovery info', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    await user.click(await screen.findByRole('row', { name: /api-7d9f/ }))
    await user.click(screen.getByRole('tab', { name: 'Logs' }))
    await waitFor(() => {
      expect(MockEventSource.instances.some(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toBe(true)
    })
    const logsStream = MockEventSource.instances.find(instance => instance.url.startsWith('/logs/'))!

    logsStream.emitError()
    expect(await screen.findByText('Log stream interrupted; waiting for EventSource to reconnect')).toBeInTheDocument()

    logsStream.emit({ type: 'INFO', info: 'following logs for pod api-7d9f' })

    await waitFor(() => {
      expect(screen.queryByText('Log stream interrupted; waiting for EventSource to reconnect')).not.toBeInTheDocument()
    })
  })

  it('keeps backend log errors visible across later stream activity', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App />)

    const [contextSelect] = await screen.findAllByRole('combobox')
    await chooseOption(user, contextSelect, /dev/)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    MockEventSource.instances[0].emit(podEvent('pod-1', 'api-7d9f'))
    MockEventSource.instances[0].emit({ type: 'SYNCED' })
    await user.click(await screen.findByRole('row', { name: /api-7d9f/ }))
    await user.click(screen.getByRole('tab', { name: 'Logs' }))
    await waitFor(() => {
      expect(MockEventSource.instances.some(instance => instance.url === '/logs/dev/pods/default/api-7d9f?tailLines=200')).toBe(true)
    })
    const logsStream = MockEventSource.instances.find(instance => instance.url.startsWith('/logs/'))!

    logsStream.emit({ type: 'ERROR', error: 'pods/log is forbidden' })
    expect(await screen.findByText('pods/log is forbidden')).toBeInTheDocument()

    act(() => {
      logsStream.emit({ type: 'INFO', info: 'following logs for pod api-7d9f' })
    })

    expect(screen.getByText('pods/log is forbidden')).toBeInTheDocument()

    act(() => {
      logsStream.emit({
        type: 'LOG',
        pod: 'api-7d9f',
        container: 'api',
        timestamp: '2026-07-08T00:00:01Z',
        line: 'api still streaming',
        seq: 1,
      })
    })

    expect(screen.getByText('pods/log is forbidden')).toBeInTheDocument()
    expect(screen.getByText(/api still streaming/)).toBeInTheDocument()

    act(() => {
      logsStream.emitError()
    })

    expect(screen.getByText('pods/log is forbidden')).toBeInTheDocument()
    expect(screen.queryByText('Log stream interrupted; waiting for EventSource to reconnect')).not.toBeInTheDocument()
  })
})
