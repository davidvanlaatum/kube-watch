import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import { useBackendLogs } from '../hooks/useBackendLogs'
import { usePodMetrics } from '../hooks/usePodMetrics'
import {
  formatCPU,
  formatMemory,
  formatSampleAge,
  isPodMetricHistoryGap,
  isPodMetricStale,
  POD_METRIC_MAX_SERIES,
  POD_METRIC_REFRESH_INTERVAL_MS,
  type PodMetricHistoryPoint,
} from '../podMetrics'
import { BackendLogToasts } from './BackendLogToasts'

type PodMetricsViewProps = {
  ctx: string
}

type ChartMetric = 'cpu' | 'memory'
type ChartSeries = {
  name: string
  color: string
  points: { timestamp: string; value: number | null; window: string }[]
}

const noPodSelection: string[] = []

export function PodMetricsView({ ctx }: PodMetricsViewProps) {
  const [selection, setSelection] = useState<{ context: string; names: string[] }>({ context: ctx, names: [] })
  const [nameFilter, setNameFilter] = useState('')
  const [now, setNow] = useState(Date.now)
  const userChangedSelection = useRef(false)
  const selectedPods = selection.context === ctx ? selection.names : noPodSelection
  const { data, error, history, isLoading, refresh } = usePodMetrics(ctx, selectedPods, now)
  const { logs: backendLogs, dismissLog } = useBackendLogs()

  useEffect(() => {
    userChangedSelection.current = false
    setSelection({ context: ctx, names: [] })
    setNameFilter('')
  }, [ctx])

  useEffect(() => {
    if (!ctx) return
    const interval = window.setInterval(() => setNow(Date.now()), POD_METRIC_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [ctx])

  useEffect(() => {
    if (!data) return
    const availableNames = new Set(data.pods.map(pod => pod.name))
    setSelection(current => {
      const currentNames = current.context === ctx ? current.names : []
      const retainedNames = currentNames.filter(name => availableNames.has(name))
      if (retainedNames.length > 0) {
        return current.context === ctx && retainedNames.length === current.names.length
          ? current
          : { context: ctx, names: retainedNames }
      }

      if (!userChangedSelection.current && data.pods.length > 0 && data.pods.length <= POD_METRIC_MAX_SERIES) {
        const nextNames = data.pods.map(pod => pod.name)
        const selectionIsCurrent = current.context === ctx
          && nextNames.length === current.names.length
          && nextNames.every((name, index) => name === current.names[index])
        return selectionIsCurrent ? current : { context: ctx, names: nextNames }
      }

      return current.context === ctx && current.names.length === 0
        ? current
        : { context: ctx, names: [] }
    })
  }, [ctx, data])

  const visiblePods = useMemo(() => {
    const filter = nameFilter.trim().toLowerCase()
    return (data?.pods || []).filter(pod => !filter || pod.name.toLowerCase().includes(filter))
  }, [data, nameFilter])
  const staleCount = useMemo(
    () => (data?.pods || []).filter(pod => isPodMetricStale(pod.timestamp, now)).length,
    [data, now],
  )

  const togglePod = (name: string, checked: boolean) => {
    userChangedSelection.current = true
    setSelection(current => {
      const currentNames = current.context === ctx ? current.names : []
      if (checked) {
        if (currentNames.includes(name) || currentNames.length >= POD_METRIC_MAX_SERIES) return current
        return { context: ctx, names: [...currentNames, name] }
      }
      return { context: ctx, names: currentNames.filter(podName => podName !== name) }
    })
  }

  const clearSelection = () => {
    userChangedSelection.current = true
    setSelection({ context: ctx, names: [] })
  }
  const lastUpdated = data?.retrievedAt ? formatClockTime(data.retrievedAt) : null
  const warnings = data?.warnings || []

  return (
    <Box component="main" sx={{ p: 2 }}>
      <BackendLogToasts logs={backendLogs} onDismiss={dismissLog} />
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 2 }}
      >
        <Box>
          <Typography variant="h5" component="h2">Pod metrics</Typography>
          <Typography variant="body2" color="text.secondary">
            Live CPU and memory usage from the Kubernetes Pod Metrics API, scoped to the selected context namespace.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          {lastUpdated && (
            <Typography variant="caption" color="text.secondary">
              Last response {lastUpdated}
            </Typography>
          )}
          <Button
            type="button"
            variant="outlined"
            size="small"
            startIcon={isLoading && !data ? <CircularProgress size={16} /> : <RefreshIcon />}
            onClick={refresh}
            disabled={!ctx}
            aria-label="Refresh pod metrics"
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      {!ctx && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Select a Kubernetes context to load pod metrics.
        </Alert>
      )}
      {ctx && isLoading && !data && (
        <Alert icon={<CircularProgress size={16} />} severity="info" role="status" sx={{ mb: 2 }}>
          Loading pod metrics for {ctx}...
        </Alert>
      )}
      {error && (
        <Alert severity={data ? 'warning' : 'error'} sx={{ mb: 2 }}>
          {error}{data ? ' Showing the last successful sample.' : ''}
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {warnings.join(' ')}
        </Alert>
      )}
      {data && staleCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {staleCount === 1 ? 'One pod sample is' : `${staleCount} pod samples are`} older than one minute or have no valid timestamp.
          Values are shown as last reported; missing values are never treated as zero.
        </Alert>
      )}
      {data && data.pods.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No pod metrics are available in namespace {data.namespace}. Metrics-server may still be collecting its first sample.
          Pods without a current metrics sample are not shown.
        </Alert>
      )}

      {ctx && (
        <>
          <Box
            data-testid="pod-metrics-chart-grid"
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
              gap: 2,
              mb: 2,
            }}
          >
            <PodMetricsChart metric="cpu" selectedNames={selectedPods} history={history} />
            <PodMetricsChart metric="memory" selectedNames={selectedPods} history={history} />
          </Box>

          <Paper component="section" aria-label="Pod metrics table" variant="outlined" sx={{ mb: 2, p: 1.5 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              sx={{ alignItems: { sm: 'center' }, mb: 1 }}
            >
              <TextField
                label="Name contains"
                type="search"
                size="small"
                value={nameFilter}
                onChange={event => setNameFilter(event.target.value)}
                placeholder="api"
                sx={{ minWidth: { sm: 220 } }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                {selectedPods.length} of up to {POD_METRIC_MAX_SERIES} chart series selected · {data?.pods.length ?? 0} pods reported
              </Typography>
              {selectedPods.length > 0 && (
                <Button type="button" size="small" onClick={clearSelection}>
                  Clear chart selection
                </Button>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0, mb: 1.5 }}>
              Select up to {POD_METRIC_MAX_SERIES} pods to graph. All reported pods remain in the table; chart selection does not truncate API data.
            </Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 'calc(100vh - 540px)', minHeight: 140 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell width={64}>Graph</TableCell>
                    <TableCell>Pod</TableCell>
                    <TableCell align="right">CPU</TableCell>
                    <TableCell align="right">Memory</TableCell>
                    <TableCell>Sample age</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visiblePods.map(pod => {
                    const selected = selectedPods.includes(pod.name)
                    const timestampStale = isPodMetricStale(pod.timestamp, now)
                    const title = pod.timestamp ? new Date(pod.timestamp).toLocaleString() : 'Metrics API did not provide a valid timestamp'
                    return (
                      <TableRow key={pod.name} hover>
                        <TableCell padding="checkbox">
                          <Tooltip title={selected ? `Remove ${pod.name} from graphs` : `Add ${pod.name} to graphs`}>
                            <span>
                              <Checkbox
                                size="small"
                                checked={selected}
                                disabled={!selected && selectedPods.length >= POD_METRIC_MAX_SERIES}
                                onChange={event => togglePod(pod.name, event.target.checked)}
                                slotProps={{ input: { 'aria-label': `Graph ${pod.name}` } }}
                              />
                            </span>
                          </Tooltip>
                        </TableCell>
                        <TableCell sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{pod.name}</TableCell>
                        <TableCell align="right">{formatCPU(pod.cpuMilliCores)}</TableCell>
                        <TableCell align="right">{formatMemory(pod.memoryBytes)}</TableCell>
                        <TableCell>
                          <Tooltip title={title}>
                            <Typography
                              component="time"
                              dateTime={pod.timestamp || undefined}
                              variant="body2"
                              color={timestampStale ? 'warning.main' : 'text.primary'}
                            >
                              {formatSampleAge(pod.timestamp, now)}
                            </Typography>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {visiblePods.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center">
                        {data?.pods.length
                          ? 'No pods match the name filter.'
                          : 'No pod metrics have been reported.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0 }}>
            History is kept in memory only while this view is open, limited to 30 minutes and 120 points per selected pod.
            Chart lines break across unavailable metrics or source-timestamp gaps.
          </Typography>
        </>
      )}
    </Box>
  )
}

function PodMetricsChart({
  metric,
  selectedNames,
  history,
}: {
  metric: ChartMetric
  selectedNames: string[]
  history: Map<string, PodMetricHistoryPoint[]>
}) {
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const isCPU = metric === 'cpu'
  const title = isCPU ? 'CPU usage' : 'Memory usage'
  const imageLabel = `${title} history by pod`
  const series = useMemo<ChartSeries[]>(() => selectedNames.map(name => ({
    name,
    color: podColor(name, isDark),
    points: (history.get(name) || []).map(point => ({
      timestamp: point.timestamp,
      value: isCPU ? point.cpuMilliCores : point.memoryBytes,
      window: point.window,
    })),
  })), [history, isCPU, isDark, selectedNames])
  const allPoints = series.flatMap(item => item.points)
  const values = allPoints
    .map(point => point.value)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const maxValue = chartCeiling(values.length ? Math.max(...values) : 0)
  const timestamps = allPoints.map(point => Date.parse(point.timestamp)).filter(Number.isFinite)
  const oldest = timestamps.length ? Math.min(...timestamps) : 0
  const newest = timestamps.length ? Math.max(...timestamps) : 0
  const chart = { width: 720, height: 260, left: 66, right: 16, top: 16, bottom: 38 }
  const plotWidth = chart.width - chart.left - chart.right
  const plotHeight = chart.height - chart.top - chart.bottom
  const x = (timestamp: string) => {
    const pointTime = Date.parse(timestamp)
    if (newest === oldest) return chart.left + plotWidth / 2
    return chart.left + ((pointTime - oldest) / (newest - oldest)) * plotWidth
  }
  const y = (value: number) => chart.top + plotHeight - (value / maxValue) * plotHeight
  const hasPoints = timestamps.length > 0 && values.length > 0
  const emptyMessage = selectedNames.length
    ? 'Waiting for timestamped samples…'
    : `Select up to ${POD_METRIC_MAX_SERIES} pods from the table to graph`

  return (
    <Paper
      component="section"
      aria-label={`${title} chart`}
      variant="outlined"
      sx={{ p: 2, minWidth: 0 }}
      data-testid={`${metric}-metrics-chart`}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 0.5 }}>
        <Typography variant="h6" component="h3">{title}</Typography>
        <Typography variant="caption" color="text.secondary">
          {isCPU ? 'millicores' : 'binary units'}
        </Typography>
      </Stack>
      <Box sx={{ width: '100%', minHeight: { xs: 200, sm: 240 } }}>
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={imageLabel}
          style={{ display: 'block', height: 'auto', width: '100%' }}
        >
          <title>{imageLabel}</title>
          {[0, 1, 2, 3, 4].map(tick => {
            const value = maxValue * tick / 4
            const yPosition = y(value)
            return (
              <g key={tick}>
                <line
                  x1={chart.left}
                  x2={chart.width - chart.right}
                  y1={yPosition}
                  y2={yPosition}
                  stroke={theme.palette.text.secondary}
                  strokeOpacity={0.18}
                />
                <text
                  x={chart.left - 8}
                  y={yPosition + 4}
                  fill={theme.palette.text.secondary}
                  fontSize="12"
                  textAnchor="end"
                >
                  {isCPU ? formatCPU(value) : formatMemory(value)}
                </text>
              </g>
            )
          })}
          {timestamps.length > 0 && (
            <>
              <text
                x={x(new Date(oldest).toISOString())}
                y={chart.height - 8}
                fill={theme.palette.text.secondary}
                fontSize="12"
                textAnchor="start"
              >
                {formatChartTime(oldest)}
              </text>
              {newest !== oldest && (
                <text
                  x={chart.width - chart.right}
                  y={chart.height - 8}
                  fill={theme.palette.text.secondary}
                  fontSize="12"
                  textAnchor="end"
                >
                  {formatChartTime(newest)}
                </text>
              )}
            </>
          )}
          {series.map(item => {
            const segments: string[] = []
            let segment = ''
            let previousPoint: ChartSeries['points'][number] | null = null
            for (const point of item.points) {
              if (point.value === null || !Number.isFinite(point.value)) {
                if (segment) segments.push(segment)
                segment = ''
                previousPoint = null
                continue
              }
              if (previousPoint && isPodMetricHistoryGap(previousPoint, point)) {
                if (segment) segments.push(segment)
                segment = ''
              }
              const nextPoint = `${x(point.timestamp).toFixed(2)} ${y(point.value).toFixed(2)}`
              segment += segment ? ` L ${nextPoint}` : `M ${nextPoint}`
              previousPoint = point
            }
            if (segment) segments.push(segment)
            return (
              <g key={item.name}>
                <path
                  d={segments.join(' ')}
                  fill="none"
                  stroke={item.color}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {item.points.map(point => point.value === null || !Number.isFinite(point.value) ? null : (
                  <circle
                    key={point.timestamp}
                    cx={x(point.timestamp)}
                    cy={y(point.value)}
                    r="3.5"
                    fill={item.color}
                  />
                ))}
              </g>
            )
          })}
          {!hasPoints && (
            <text
              x={chart.left + plotWidth / 2}
              y={chart.top + plotHeight / 2}
              fill={theme.palette.text.secondary}
              fontSize="13"
              textAnchor="middle"
            >
              {emptyMessage}
            </text>
          )}
        </svg>
      </Box>
      <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: 'wrap', mt: 0.5 }}>
        {series.map(item => (
          <Stack key={item.name} direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Box aria-hidden="true" sx={{ width: 10, height: 10, flex: '0 0 auto', borderRadius: '50%', bgcolor: item.color }} />
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>{item.name}</Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  )
}

function chartCeiling(maxValue: number) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 1
  const target = maxValue * 1.1
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const normalized = target / magnitude
  const niceValue = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return niceValue * magnitude
}

function podColor(name: string, isDark: boolean) {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 68% ${isDark ? 70 : 48}%)`
}

function formatChartTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

function formatClockTime(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'time unavailable'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}
