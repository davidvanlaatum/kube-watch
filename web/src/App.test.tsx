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

describe('App', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve([{ name: 'dev', namespace: 'default' }]),
    }))
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
    expect(within(row).getByText('2 (5m ago)')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Copy api-7d9f' }))

    await waitFor(() => {
      expect(within(row).getByRole('button', { name: 'Copy api-7d9f' })).toHaveTextContent('Copied')
    })
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
})
