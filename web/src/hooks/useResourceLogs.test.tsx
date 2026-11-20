import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEnvelope } from '../types'
import { useResourceLogs } from './useResourceLogs'

class MockEventSource {
  static current: MockEventSource
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
  constructor() { MockEventSource.current = this }
  emit(event: LogEnvelope) {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>))
  }
}

function renderLogs() {
  return renderHook(() => useResourceLogs({
    ctx: 'dev', resource: 'pods',
    selectedItem: { metadata: { name: 'api-1', namespace: 'default' }, spec: { containers: [{ name: 'app' }] } },
    supportsLogs: true, detailsTab: 'logs', tailLines: 200, isDetailsMaximized: false,
  }))
}

const startupError = {
  type: 'ERROR', pod: 'api-1', container: 'app',
  error: 'api-1/app follow logs failed: container is waiting to start: PodInitializing',
}

describe('log stream recovery', () => {
  beforeEach(() => vi.stubGlobal('EventSource', MockEventSource))
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it.each(['LOG', 'INFO'])('clears the startup error on a matching %s event', type => {
    const { result } = renderLogs()
    const stream = MockEventSource.current
    stream.emit(startupError)
    expect(result.current.error).toBe(startupError.error)

    stream.emit({ type, pod: 'api-1', container: 'app', line: type === 'LOG' ? 'started' : undefined })
    expect(result.current.error).toBeNull()
    if (type === 'LOG') expect(result.current.sortedEntries[0].line).toBe('started')
  })

  it('keeps the startup error until that particular container recovers', () => {
    const { result } = renderLogs()
    const stream = MockEventSource.current
    stream.emit(startupError)
    stream.emit({ type: 'INFO', info: 'following logs for pod api-1' })
    stream.emit({ type: 'INFO', pod: 'api-1', container: 'sidecar' })
    stream.emit({ type: 'LOG', pod: 'api-2', container: 'app', line: 'other pod' })
    expect(result.current.error).toBe(startupError.error)

    stream.emit({ type: 'INFO', pod: 'api-1', container: 'app' })
    expect(result.current.error).toBeNull()
    stream.emit(startupError)
    expect(result.current.error).toBe(startupError.error)
  })
})
