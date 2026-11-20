import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { metricColumns, MetricsDetails } from './MetricsDetails'
import { sortItems } from '../resourceSort'
import type { MetricsSnapshot, WorkloadMetrics } from '../metrics'

afterEach(cleanup)
const zero = { cpu: 0, memory: 0 }
const pod: WorkloadMetrics = {
  uid: 'pod', name: 'web-pod', usage: { cpu: 125, memory: 128 * 1024 ** 2 }, requests: { cpu: 100, memory: 64 * 1024 ** 2 }, limits: zero,
  reporting: 1, expected: 2, updated: 100_000, history: [{ time: 100_000, usage: { cpu: 125, memory: 128 * 1024 ** 2 } }],
  containers: [{ name: 'app', usage: { cpu: 125, memory: 128 * 1024 ** 2 }, requests: zero, limits: zero }, { name: 'sidecar', usage: null, requests: zero, limits: zero }],
}
const snapshot: MetricsSnapshot = { time: 100_000, items: { pod }, pods: { pod } }
describe('metrics presentation', () => {
  it('shows pod container usage, missing values, resource references and incomplete coverage', () => {
    render(<MetricsDetails workload={pod} snapshot={snapshot} deployment={false} />)
    expect(screen.getByText(/1 of 2 containers reporting/)).toBeInTheDocument()
    expect(screen.getByText(/Usage is incomplete/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Container metrics' })).toHaveTextContent('sidecar')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })
  it('shows deployment pod breakdown and averages over reporting pods', () => {
    const deployment = { ...pod, uid: 'deployment', pods: ['pod', 'missing'], containers: undefined, reporting: 2, expected: 2 }
    render(<MetricsDetails workload={deployment} snapshot={snapshot} deployment />)
    expect(screen.getByText(/Average per reporting pod: CPU 62.5m; memory 64 MiB/)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Pod metrics' })).toHaveTextContent('web-pod')
    expect(screen.queryByText(/Usage is incomplete/)).not.toBeInTheDocument()
  })
  it('shows unavailable data and explains API failures', () => {
    const { rerender } = render(<MetricsDetails deployment={false} />)
    expect(screen.getByText('Waiting for metrics...')).toBeInTheDocument()
    rerender(<MetricsDetails deployment error="Metrics API unavailable" />)
    expect(screen.getByText('Metrics API unavailable')).toBeInTheDocument()
    rerender(<MetricsDetails workload={{ ...pod, usage: null, updated: 0, reporting: 0 }} snapshot={snapshot} deployment />)
    expect(screen.getByText(/No current sample/)).toBeInTheDocument()
    expect(screen.getByText(/Average per reporting pod: CPU —; memory —/)).toBeInTheDocument()
  })
  it('sorts using numeric usage rather than formatted text and marks partial totals', () => {
    const items = [{ metadata: { uid: 'small' } }, { metadata: { uid: 'large' } }, { metadata: { uid: 'missing' } }]
    const data = { ...snapshot, items: { small: { ...pod, usage: { cpu: 9, memory: 0 } }, large: { ...pod, usage: { cpu: 100, memory: 0 } } } }
    const columns = metricColumns(data)
    expect(sortItems('pods', [...items], { columnId: 'cpu', direction: 'desc' }, columns)).toEqual([items[1], items[0], items[2]])
    render(<>{columns[0].value(items[0])}{columns[0].value(items[2])}</>)
    expect(screen.getByText('9m *')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(metricColumns()[0].sortValue?.(items[0])).toBe(-1)
  })
})
