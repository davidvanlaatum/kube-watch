import { useState } from 'react'
import { Box, Typography, useTheme } from '@mui/material'
import { formatUsage, historyDuration, type MetricPoint, type Usage } from '../metrics'

export function chartSegments(points: MetricPoint[], metric: keyof Usage, start: number, end: number) {
  const segments: { time: number; value: number }[][] = []
  let segment: { time: number; value: number }[] = []
  for (const point of points) {
    if (point.time < start || point.time > end) continue
    const value = point.usage?.[metric]
    if (value === undefined || !Number.isFinite(value) || (segment.length && point.time - segment[segment.length - 1].time > 45_000)) {
      if (segment.length) segments.push(segment)
      segment = []
    }
    if (value !== undefined && Number.isFinite(value)) segment.push({ time: point.time, value })
  }
  if (segment.length) segments.push(segment)
  return segments
}

export function UsageChart({ points, metric, now, compact = false, request = 0, limit = 0 }: {
  points: MetricPoint[]; metric: keyof Usage; now: number; compact?: boolean; request?: number; limit?: number
}) {
  const theme = useTheme()
  const references = request > 0 && request === limit
    ? [{ value: request, label: 'Requests and limits', color: theme.palette.text.secondary, dash: '6 4' }]
    : [
        { value: request, label: 'Requests', color: theme.palette.warning.main, dash: '6 4' },
        { value: limit, label: 'Limits', color: theme.palette.secondary.main, dash: '2 4' },
      ].filter(ref => ref.value > 0)
  const [hover, setHover] = useState<number | null>(null)
  const start = now - historyDuration
  const segments = chartSegments(points, metric, start, now)
  const values = segments.flat()
  const max = Math.max(1, ...values.map(p => p.value), compact ? 0 : request, compact ? 0 : limit) * 1.1
  const width = compact ? 90 : 600
  const height = compact ? 24 : 180
  const left = compact ? 1 : 80, right = width - 2, top = 8, bottom = height - (compact ? 2 : 28)
  const x = (time: number) => left + (time - start) / historyDuration * (right - left)
  const y = (value: number) => bottom - value / max * (bottom - top)
  const nearest = hover === null ? undefined : values.reduce<typeof values[number] | undefined>((best, p) => !best || Math.abs(p.time - hover) < Math.abs(best.time - hover) ? p : best, undefined)
  const label = `${metric === 'cpu' ? 'CPU' : 'Memory'} usage over the last 15 minutes`
  return (
    <Box sx={{ minWidth: 0, color: theme => theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.main, width: compact ? 90 : '100%', flexShrink: 0 }}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', display: 'block' }}
        onPointerLeave={() => setHover(null)}
        onPointerMove={compact ? undefined : event => {
          const rect = event.currentTarget.getBoundingClientRect()
          const position = (event.clientX - rect.left) / rect.width * width
          setHover(start + Math.max(0, Math.min(1, (position - left) / (right - left))) * historyDuration)
        }}>
        <title>{label}. {values.length ? 'Sampled usage; gaps indicate unavailable data.' : 'Waiting for samples.'}</title>
        {!compact && <>
          {[0, max / 2, max].map(value => <g key={value}>
            <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity="0.12" />
            <text x={left - 8} y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="11">{formatUsage(value, metric)}</text>
          </g>)}
          <text x={left} y={height - 6} fill="currentColor" fontSize="11">{new Date(start).toLocaleTimeString()}</text>
          <text x={right} y={height - 6} textAnchor="end" fill="currentColor" fontSize="11">{new Date(now).toLocaleTimeString()}</text>
          {references.map(ref =>
            <line key={ref.label} x1={left} x2={right} y1={y(ref.value)} y2={y(ref.value)} stroke={ref.color} strokeWidth="1.5" strokeDasharray={ref.dash} vectorEffect="non-scaling-stroke">
              <title>Configured {ref.label.toLowerCase()}: {formatUsage(ref.value, metric)}</title>
            </line>)}
        </>}
        {segments.map((segment, index) => <g key={index}>
          <polyline points={segment.map(p => `${x(p.time)},${y(p.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth={compact ? 1.5 : 2} />
          {segment.length === 1 && <circle cx={x(segment[0].time)} cy={y(segment[0].value)} r="2" fill="currentColor" />}
        </g>)}
        {nearest && <circle cx={x(nearest.time)} cy={y(nearest.value)} r="4" fill="currentColor" />}
      </svg>
      {!compact && <Typography variant="caption" color="text.secondary" component="div" sx={{ minHeight: 20 }}>
        {nearest ? `${new Date(nearest.time).toLocaleTimeString()}: ${formatUsage(nearest.value, metric)}` : 'Hover for sample values.'}
      </Typography>}
      {!compact && <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, color: 'text.secondary' }}>
        {references.map(ref => <Typography key={ref.label} variant="caption" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
          <svg width="30" height="10" aria-hidden="true"><line x1="0" x2="30" y1="5" y2="5" stroke={ref.color} strokeWidth="1.5" strokeDasharray={ref.dash} /></svg>
          {ref.label}: {formatUsage(ref.value, metric)}
        </Typography>)}
      </Box>}
    </Box>
  )
}
