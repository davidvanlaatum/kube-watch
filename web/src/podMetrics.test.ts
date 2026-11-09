import { describe, expect, it } from 'vitest'
import {
  formatCPU,
  formatMemory,
  formatSampleAge,
  isPodMetricHistoryGap,
  isPodMetricStale,
  POD_METRIC_HISTORY_WINDOW_MS,
  POD_METRIC_MAX_SAMPLES,
  updatePodMetricHistory,
  type PodMetric,
} from './podMetrics'

function metric(name: string, timestamp: string | null, cpuMilliCores: number | null, memoryBytes: number | null): PodMetric {
  return { name, timestamp, window: '30s', cpuMilliCores, memoryBytes }
}

describe('pod metrics helpers', () => {
  it('formats CPU and memory values without substituting missing values', () => {
    expect(formatCPU(null)).toBe('—')
    expect(formatCPU(0)).toBe('0m')
    expect(formatCPU(250)).toBe('250m')
    expect(formatCPU(1250)).toBe('1.3 cores')
    expect(formatMemory(null)).toBe('—')
    expect(formatMemory(1024)).toBe('1 KiB')
    expect(formatMemory(42 * 1024 * 1024)).toBe('42 MiB')
    expect(formatMemory(2 * 1024 ** 3)).toBe('2 GiB')
  })

  it('keeps bounded, timestamped history only for selected pods', () => {
    let history = updatePodMetricHistory(
      new Map(),
      ['api'],
      [metric('api', '2026-11-06T06:00:00Z', 200, 10 * 1024 * 1024), metric('worker', '2026-11-06T06:00:00Z', 50, 5 * 1024 * 1024)],
    )
    expect([...history.keys()]).toEqual(['api'])
    expect(history.get('api')).toHaveLength(1)

    history = updatePodMetricHistory(
      history,
      ['api'],
      [metric('api', '2026-11-06T06:00:00Z', 999, 99 * 1024 * 1024)],
    )
    expect(history.get('api')).toHaveLength(1)
    expect(history.get('api')?.[0].cpuMilliCores).toBe(200)

    const samples = Array.from({ length: POD_METRIC_MAX_SAMPLES + 5 }, (_, index) => {
      const timestamp = new Date(Date.parse('2026-11-06T06:00:15Z') + index * 15_000).toISOString()
      return metric('api', timestamp, index, index * 1024)
    })
    history = updatePodMetricHistory(history, ['api'], samples, samples[samples.length - 1].timestamp || undefined)
    expect(history.get('api')).toHaveLength(POD_METRIC_MAX_SAMPLES)
    expect(history.get('api')?.[0].cpuMilliCores).toBe(5)

    history = updatePodMetricHistory(history, [], [metric('api', '2026-11-06T06:01:00Z', 300, 20)])
    expect(history.size).toBe(0)
  })

  it('preserves the history reference when selected samples have not changed', () => {
    const sample = metric('api', '2026-11-06T06:00:00Z', 200, 10 * 1024 * 1024)
    const history = updatePodMetricHistory(new Map(), ['api'], [sample], '2026-11-06T06:00:15Z')
    const unchanged = updatePodMetricHistory(
      history,
      ['api'],
      [{ ...sample, cpuMilliCores: 999 }],
      '2026-11-06T06:00:30Z',
    )

    expect(unchanged).toBe(history)
  })

  it('trims history to the actual time horizon as well as the sample bound', () => {
    const retrievedAt = Date.parse('2026-11-06T06:00:00Z')
    const timestamps = [
      retrievedAt - POD_METRIC_HISTORY_WINDOW_MS - 1,
      retrievedAt - POD_METRIC_HISTORY_WINDOW_MS,
      retrievedAt - 60_000,
    ]
    const history = updatePodMetricHistory(
      new Map(),
      ['api'],
      timestamps.map((timestamp, index) => metric('api', new Date(timestamp).toISOString(), index, index)),
      new Date(retrievedAt).toISOString(),
    )

    expect(history.get('api')?.map(point => point.timestamp)).toEqual([
      new Date(timestamps[1]).toISOString(),
      new Date(timestamps[2]).toISOString(),
    ])
  })

  it('identifies gaps using the polling cadence and metrics sample window', () => {
    const previous = { timestamp: '2026-11-06T06:00:00Z', window: '30s' }
    expect(isPodMetricHistoryGap(previous, {
      timestamp: '2026-11-06T06:00:30Z',
      window: '30s',
    })).toBe(false)
    expect(isPodMetricHistoryGap(previous, {
      timestamp: '2026-11-06T06:00:31Z',
      window: '30s',
    })).toBe(true)
    expect(isPodMetricHistoryGap(
      { timestamp: previous.timestamp, window: '1m0s' },
      { timestamp: '2026-11-06T06:00:45Z', window: '1m0s' },
    )).toBe(false)
  })

  it('does not record metrics without valid source timestamps', () => {
    const history = updatePodMetricHistory(
      new Map(),
      ['api'],
      [metric('api', null, 300, 20), metric('worker', 'not-a-time', 100, 10)],
    )
    expect(history.size).toBe(0)
  })

  it('reports sample freshness', () => {
    const now = Date.parse('2026-11-06T06:01:00Z')
    expect(formatSampleAge('2026-11-06T06:00:30Z', now)).toBe('30s ago')
    expect(formatSampleAge(null, now)).toBe('Timestamp unavailable')
    expect(isPodMetricStale('2026-11-06T05:59:00Z', now)).toBe(true)
    expect(isPodMetricStale('2026-11-06T06:00:30Z', now)).toBe(false)
    expect(isPodMetricStale(null, now)).toBe(true)
  })
})
