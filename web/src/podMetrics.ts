export type PodMetric = {
  name: string
  timestamp: string | null
  window: string
  cpuMilliCores: number | null
  memoryBytes: number | null
}

export type PodMetricsSnapshot = {
  namespace: string
  retrievedAt: string
  pods: PodMetric[]
  warnings: string[]
}

export type PodMetricHistoryPoint = {
  timestamp: string
  cpuMilliCores: number | null
  memoryBytes: number | null
  window: string
}

export const POD_METRIC_REFRESH_INTERVAL_MS = 15_000
export const POD_METRIC_MAX_SAMPLES = 120
export const POD_METRIC_MAX_SERIES = 8
export const POD_METRIC_STALE_AFTER_MS = 60_000
export const POD_METRIC_HISTORY_WINDOW_MS = 30 * 60_000

const kibibyte = 1024
const mebibyte = kibibyte ** 2
const gibibyte = kibibyte ** 3

export function updatePodMetricHistory(
  previous: Map<string, PodMetricHistoryPoint[]>,
  selectedNames: string[],
  pods: PodMetric[],
  retrievedAt?: string,
) {
  const selected = new Set(selectedNames)
  const retrievedAtMillis = retrievedAt ? Date.parse(retrievedAt) : Number.NaN
  const historyCutoff = Number.isFinite(retrievedAtMillis)
    ? retrievedAtMillis - POD_METRIC_HISTORY_WINDOW_MS
    : null
  let next = previous
  let changed = false
  const ensureCopy = () => {
    if (!changed) {
      next = new Map(previous)
      changed = true
    }
  }

  for (const [name, points] of previous) {
    if (!selected.has(name)) {
      ensureCopy()
      next.delete(name)
      continue
    }
    if (historyCutoff !== null) {
      const retained = points.filter(point => {
        const timestamp = Date.parse(point.timestamp)
        return Number.isFinite(timestamp) && timestamp >= historyCutoff
      })
      if (retained.length !== points.length) {
        ensureCopy()
        if (retained.length > 0) next.set(name, retained)
        else next.delete(name)
      }
    }
  }

  for (const pod of pods) {
    if (!selected.has(pod.name) || !pod.timestamp) continue
    const timestamp = Date.parse(pod.timestamp)
    if (!Number.isFinite(timestamp)) continue
    if (historyCutoff !== null && timestamp < historyCutoff) continue

    const points = next.get(pod.name) || []
    const latestTimestamp = points.length > 0 ? Date.parse(points[points.length - 1].timestamp) : -Infinity
    if (timestamp <= latestTimestamp) continue

    ensureCopy()
    next.set(pod.name, [
      ...points,
      {
        timestamp: pod.timestamp,
        cpuMilliCores: pod.cpuMilliCores,
        memoryBytes: pod.memoryBytes,
        window: pod.window,
      },
    ].slice(-POD_METRIC_MAX_SAMPLES))
  }

  return changed ? next : previous
}

export function isPodMetricHistoryGap(
  previous: Pick<PodMetricHistoryPoint, 'timestamp' | 'window'>,
  current: Pick<PodMetricHistoryPoint, 'timestamp' | 'window'>,
) {
  const previousTimestamp = Date.parse(previous.timestamp)
  const currentTimestamp = Date.parse(current.timestamp)
  if (!Number.isFinite(previousTimestamp) || !Number.isFinite(currentTimestamp) || currentTimestamp <= previousTimestamp) {
    return false
  }

  const sampleWindow = Math.max(parseMetricsDuration(previous.window), parseMetricsDuration(current.window))
  const allowedGap = Math.max(POD_METRIC_REFRESH_INTERVAL_MS * 2, sampleWindow)
  return currentTimestamp - previousTimestamp > allowedGap
}

export function formatCPU(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value >= 1000) return `${formatNumber(value / 1000)} cores`
  return `${Math.round(value)}m`
}

export function formatMemory(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value >= gibibyte) return `${formatNumber(value / gibibyte)} GiB`
  if (value >= mebibyte) return `${formatNumber(value / mebibyte)} MiB`
  if (value >= kibibyte) return `${formatNumber(value / kibibyte)} KiB`
  return `${Math.round(value)} B`
}

export function formatSampleAge(timestamp: string | null, now = Date.now()) {
  if (!timestamp) return 'Timestamp unavailable'
  const sampledAt = Date.parse(timestamp)
  if (!Number.isFinite(sampledAt)) return 'Timestamp unavailable'
  const ageSeconds = Math.max(0, Math.floor((now - sampledAt) / 1000))
  if (ageSeconds < 60) return ageSeconds === 0 ? 'just now' : `${ageSeconds}s ago`
  const ageMinutes = Math.floor(ageSeconds / 60)
  if (ageMinutes < 60) return `${ageMinutes}m ago`
  const ageHours = Math.floor(ageMinutes / 60)
  if (ageHours < 24) return `${ageHours}h ago`
  return `${Math.floor(ageHours / 24)}d ago`
}

export function isPodMetricStale(timestamp: string | null, now = Date.now()) {
  if (!timestamp) return true
  const sampledAt = Date.parse(timestamp)
  return !Number.isFinite(sampledAt) || now - sampledAt > POD_METRIC_STALE_AFTER_MS
}

function formatNumber(value: number) {
  return Number.isInteger(Number(value.toFixed(1))) ? String(Math.round(value)) : value.toFixed(1)
}

function parseMetricsDuration(value: string) {
  const units: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    'µs': 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  }
  const normalized = value.trim()
  const durationPattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g
  let consumed = 0
  let total = 0

  for (const match of normalized.matchAll(durationPattern)) {
    if (match.index !== consumed) return 0
    total += Number(match[1]) * units[match[2]]
    consumed += match[0].length
  }

  return consumed === normalized.length && Number.isFinite(total) ? total : 0
}
