import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { metricColumns, MetricsDetails } from './MetricsDetails'
import { sortItems } from '../resourceSort'
import { allocationLabel, withAggregation, type MetricsSnapshot, type WorkloadMetrics } from '../metrics'

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

describe('list allocation comparisons', () => {
  const container = { name: 'app', usage: { cpu: 125, memory: 128 * 1024 ** 2 }, requests: { cpu: 100, memory: 64 * 1024 ** 2 }, limits: { cpu: 500, memory: 256 * 1024 ** 2 } }
  const workload: WorkloadMetrics = { ...pod, expected: 1, reporting: 1, containers: [container], requests: container.requests, limits: container.limits }
  function show(w: WorkloadMetrics, deployment = false, pods = { pod: w }) {
    const data = { ...snapshot, items: { [w.uid]: w }, pods }
    render(<>{metricColumns(data).map(column => <div key={column.id}>{column.value({ kind: deployment ? 'Deployment' : 'Pod', metadata: { uid: w.uid } })}</div>)}</>)
  }
  it('prefers limits and shows numeric usage percentages', () => {
    show(workload)
    expect(screen.getByText('/ 500m limit (25%)')).toBeInTheDocument()
    expect(screen.getByText('/ 256 MiB limit (50%)')).toBeInTheDocument()
  })
  it('falls back to requests independently for CPU and memory', () => {
    show({ ...workload, limits: { cpu: 0, memory: container.limits.memory }, containers: [{ ...container, limits: { cpu: 0, memory: container.limits.memory } }] })
    expect(screen.getByText('/ 100m request (125%)')).toBeInTheDocument()
    expect(screen.getByText('/ 256 MiB limit (50%)')).toBeInTheDocument()
  })
  it('falls back to a complete request when only some containers have limits', () => {
    const unbounded = { ...container, name: 'sidecar', limits: zero }
    show({ ...workload, expected: 2, reporting: 2, requests: { cpu: 200, memory: 128 * 1024 ** 2 }, containers: [container, unbounded] })
    expect(screen.getByText('/ 200m request (62.5%)')).toBeInTheDocument()
    expect(screen.getByText('/ 128 MiB request (100%)')).toBeInTheDocument()
  })
  it('marks partial allocations without a misleading percentage', () => {
    const unset = { ...container, name: 'sidecar', requests: zero, limits: zero }
    show({ ...workload, expected: 2, reporting: 2, containers: [container, unset] })
    expect(screen.getByText('/ 500m partial limit')).toBeInTheDocument()
    expect(screen.getByText('/ 256 MiB partial limit')).toBeInTheDocument()
  })
  it('avoids percentages when usage is missing or incomplete', () => {
    show({ ...workload, reporting: 0, usage: null })
    expect(screen.getByText('/ 500m limit')).toBeInTheDocument()
    expect(screen.getByText('/ 256 MiB limit')).toBeInTheDocument()
  })
  it('handles workloads with no configured allocation', () => {
    show({ ...workload, requests: zero, limits: zero, containers: [{ ...container, requests: zero, limits: zero }] })
    expect(screen.getAllByText('· no request/limit')).toHaveLength(2)
  })
  it('uses deployment ownership pods to verify allocation coverage', () => {
    show({ ...workload, uid: 'deployment', containers: undefined, pods: ['pod'] }, true, { pod: workload })
    expect(screen.getByText('/ 500m limit (25%)')).toBeInTheDocument()
  })
})

describe('deployment aggregations', () => {
  const makePod = (uid: string, cpu: number, memory: number, cpuLimit: number, memoryLimit: number): WorkloadMetrics => ({
    ...pod, uid, name: uid, reporting: 1, expected: 1, usage: { cpu, memory }, requests: zero, limits: { cpu: cpuLimit, memory: memoryLimit },
    containers: [{ name: 'app', usage: { cpu, memory }, requests: zero, limits: { cpu: cpuLimit, memory: memoryLimit } }],
  })
  const a = makePod('a', 100, 400, 200, 800), b = makePod('b', 300, 100, 600, 200)
  const aggregations = { sum: { cpu: 400, memory: 500 }, avg: { cpu: 200, memory: 250 }, min: { cpu: 100, memory: 100 }, max: { cpu: 300, memory: 400 } }
  const deployment: WorkloadMetrics = { ...pod, uid: 'deployment', containers: undefined, pods: ['a', 'b'], reporting: 2, expected: 2, usage: aggregations.sum, requests: zero, limits: { cpu: 800, memory: 1000 }, aggregations, history: [{ time: 100_000, usage: aggregations.sum, aggregations }, { time: 115_000, usage: null }] }
  const data = { ...snapshot, items: { deployment }, pods: { a, b } }
  it('switches current values and retained chart samples without changing the source snapshot', () => {
    for (const mode of ['sum', 'avg', 'min', 'max'] as const) {
      const selected = withAggregation(deployment, mode)!
      expect(selected.usage).toEqual(aggregations[mode])
      expect(selected.history[0].usage).toEqual(aggregations[mode])
      expect(selected.history[1].usage).toBeNull()
    }
    expect(deployment.usage).toEqual(aggregations.sum)
    expect(withAggregation(undefined, 'min')).toBeUndefined()
    expect(withAggregation({ ...deployment, aggregations: undefined }, 'avg')?.usage).toBeNull()
  })
  it('uses average allocations for averages and the supplying pod allocation for extrema', () => {
    const average = withAggregation(deployment, 'avg')!
    expect(allocationLabel(average, 'cpu', data, 'avg')).toBe(' / 400m limit (50%)')
    const minimum = withAggregation(deployment, 'min')!
    expect(allocationLabel(minimum, 'cpu', data, 'min')).toBe(' / 200m limit (50%)')
    expect(allocationLabel(minimum, 'memory', data, 'min')).toContain('limit (50%)')
    const maximum = withAggregation(deployment, 'max')!
    expect(allocationLabel(maximum, 'cpu', data, 'max')).toBe(' / 600m limit (50%)')
    expect(allocationLabel(maximum, 'memory', data, 'max')).toContain('limit (50%)')
    expect(allocationLabel({ ...maximum, reporting: 1 }, 'cpu', data, 'max')).toBe(' / 600m limit')
    expect(allocationLabel({ ...minimum, pods: [] }, 'cpu', data, 'min')).toBe(' · no reporting pods')
  })
  it('uses the selected statistic for sorting and labels detail charts', () => {
    const column = metricColumns(data, 'max')[0]
    expect(column.header).toBe('CPU (MAX)')
    expect(column.sortValue?.({ metadata: { uid: 'deployment' } })).toBe(300)
    const { rerender } = render(<MetricsDetails workload={deployment} snapshot={data} deployment />)
    expect(screen.getByText('CPU (Average): 200m')).toBeInTheDocument()
    rerender(<MetricsDetails workload={deployment} snapshot={data} deployment aggregation="max" />)
    expect(screen.getByText('CPU (Maximum): 300m')).toBeInTheDocument()
    expect(screen.getByText(/Maximum across reporting pods/)).toBeInTheDocument()
    expect(screen.getByText(/Allocation reference lines follow the current pod/)).toBeInTheDocument()
  })
})
