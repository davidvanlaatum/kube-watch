import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDetailsPanelOffset } from './useDetailsPanelOffset'

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this)
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

type OffsetHarnessProps = {
  isOpen?: boolean
  selectionKey?: string | null
  isMaximized?: boolean
}

function OffsetHarness({ isOpen = true, selectionKey = 'pod-1', isMaximized = false }: OffsetHarnessProps) {
  const { panelRef, offset } = useDetailsPanelOffset({
    isOpen,
    selectionKey,
    detailsTab: 'yaml',
    showFullDetails: false,
    isMaximized,
    historyLength: 0,
    historyLoading: false,
    logEntryCount: 0,
    eventCount: 0,
  })

  return <div ref={panelRef} data-testid="panel" data-offset={offset} />
}

describe('useDetailsPanelOffset', () => {
  let height = 100

  beforeEach(() => {
    height = 100
    MockResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: 0,
      bottom: height,
      left: 0,
      width: 0,
      height,
      toJSON: () => ({}),
    }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('updates the offset through ResizeObserver and resets it when closed', () => {
    const { rerender } = render(<OffsetHarness />)

    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '124')
    expect(MockResizeObserver.instances).toHaveLength(1)

    height = 200
    act(() => {
      MockResizeObserver.instances[0].trigger()
    })
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '224')

    rerender(<OffsetHarness isOpen={false} />)
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '0')
    expect(MockResizeObserver.instances[0].disconnect).toHaveBeenCalledOnce()
  })

  it('remeasures on selection changes and window resize without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { rerender } = render(<OffsetHarness />)

    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '124')

    height = 200
    rerender(<OffsetHarness selectionKey="pod-2" />)
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '224')

    height = 300
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '324')
  })

  it('clears the reserved table offset when the details drawer is maximized', () => {
    const { rerender } = render(<OffsetHarness />)
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '124')

    rerender(<OffsetHarness isMaximized />)
    expect(screen.getByTestId('panel')).toHaveAttribute('data-offset', '0')
  })
})
