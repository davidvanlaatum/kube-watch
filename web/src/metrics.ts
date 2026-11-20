export type Usage = { cpu: number; memory: number }
export type MetricPoint = { time: number; usage: Usage | null }
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

export function allocationLabel(workload: WorkloadMetrics, metric: keyof Usage, snapshot: MetricsSnapshot) {
  const completeLimit = allocationComplete(workload, 'limits', metric, snapshot)
  const completeRequest = allocationComplete(workload, 'requests', metric, snapshot)
  const field = completeLimit ? 'limits' : completeRequest ? 'requests' : workload.limits[metric] > 0 ? 'limits' : 'requests'
  const value = workload[field][metric]
  if (!value) return ' · no request/limit'
  const complete = field === 'limits' ? completeLimit : completeRequest
  const percentage = complete && workload.usage && workload.reporting === workload.expected
    ? ` (${Number((workload.usage[metric] / value * 100).toFixed(1))}%)` : ''
  return ` / ${formatUsage(value, metric)} ${complete ? '' : 'partial '}${field === 'limits' ? 'limit' : 'request'}${percentage}`
}
