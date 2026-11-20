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
