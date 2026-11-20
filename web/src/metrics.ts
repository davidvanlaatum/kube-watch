export type Aggregation = 'sum' | 'avg' | 'min' | 'max'
export const aggregationLabels: Record<Aggregation, string> = { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum' }
export type Usage = { cpu: number; memory: number }
export type MetricPoint = { time: number; usage: Usage | null; aggregations?: Partial<Record<Aggregation, Usage | null>> }
export type ContainerMetrics = { name: string; usage: Usage | null; requests: Usage; limits: Usage }
export type WorkloadMetrics = {
  uid: string
  name: string
  usage: Usage | null
  requests: Usage
  limits: Usage
  reporting: number
  expected: number
  containers?: ContainerMetrics[]
  pods?: string[]
  history: MetricPoint[]
  updated: number
  aggregations?: Partial<Record<Aggregation, Usage | null>>
}
export type MetricsSnapshot = {
  time: number
  items: Record<string, WorkloadMetrics> | null
  pods: Record<string, WorkloadMetrics> | null
  error?: string
}
export const historyDuration = 15 * 60_000
export const supportsMetrics = (resource: string) => resource === 'pods' || resource === 'deployments'
export function formatUsage(value: number | undefined, metric: keyof Usage) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (metric === 'cpu') return `${Number(value.toFixed(1))}m`
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${Number((value / 1024 ** 2).toFixed(1))} MiB`
}
export function coverage(w: WorkloadMetrics, deployment: boolean) {
  return `${w.reporting} of ${w.expected} ${deployment ? 'pods' : 'containers'} reporting`
}

function allocationComplete(workload: WorkloadMetrics, field: 'requests' | 'limits', metric: keyof Usage, snapshot: MetricsSnapshot): boolean {
  if (workload.containers) {
    return workload.containers.length > 0 && workload.containers.length === workload.expected && workload.containers.every(container => container[field][metric] > 0)
  }
  const pods = (workload.pods || []).map(uid => snapshot.pods?.[uid])
  return pods.length > 0 && pods.length === workload.expected && pods.every(pod => pod && allocationComplete(pod, field, metric, snapshot))
}

export function allocationSource(workload: WorkloadMetrics, metric: keyof Usage, snapshot: MetricsSnapshot, aggregation: Aggregation) {
  if (aggregation !== 'min' && aggregation !== 'max') return workload
  const pods = (workload.pods || []).flatMap(uid => snapshot.pods?.[uid] ? [snapshot.pods[uid]] : []).filter(pod => pod.usage && pod.reporting === pod.expected)
  return pods.reduce<WorkloadMetrics | undefined>((selected, pod) => !selected || (aggregation === 'min' ? pod.usage![metric] < selected.usage![metric] : pod.usage![metric] > selected.usage![metric]) ? pod : selected, undefined)
}

export function withAggregation(workload: WorkloadMetrics | undefined, aggregation: Aggregation): WorkloadMetrics | undefined {
  if (!workload || aggregation === 'sum') return workload
  const divisor = aggregation === 'avg' && workload.expected > 0 ? workload.expected : 1
  const divide = (value: Usage): Usage => ({ cpu: value.cpu / divisor, memory: value.memory / divisor })
  return {
    ...workload,
    usage: workload.aggregations?.[aggregation] ?? null,
    requests: divide(workload.requests), limits: divide(workload.limits),
    history: workload.history.map(point => ({ ...point, usage: point.aggregations?.[aggregation] ?? null })),
  }
}

export function allocationLabel(workload: WorkloadMetrics, metric: keyof Usage, snapshot: MetricsSnapshot, aggregation: Aggregation = 'sum') {
  const source = allocationSource(workload, metric, snapshot, aggregation)
  if (!source) return ' · no reporting pods'
  const completeLimit = allocationComplete(source, 'limits', metric, snapshot)
  const completeRequest = allocationComplete(source, 'requests', metric, snapshot)
  const field = completeLimit ? 'limits' : completeRequest ? 'requests' : source.limits[metric] > 0 ? 'limits' : 'requests'
  const value = source[field][metric]
  if (!value) return ' · no request/limit'
  const complete = field === 'limits' ? completeLimit : completeRequest
  const percentage = complete && workload.usage && workload.reporting === workload.expected
    ? ` (${Number((workload.usage[metric] / value * 100).toFixed(1))}%)` : ''
  return ` / ${formatUsage(value, metric)} ${complete ? '' : 'partial '}${field === 'limits' ? 'limit' : 'request'}${percentage}`
}
