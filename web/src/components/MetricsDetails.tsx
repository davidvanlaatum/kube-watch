import { Alert, Box, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material'
import { coverage, formatUsage, type ContainerMetrics, type MetricsSnapshot, type WorkloadMetrics, type Usage } from '../metrics'
import type { Column } from '../types'
import { UsageChart } from './UsageChart'

export function metricColumns(snapshot?: MetricsSnapshot): Column[] {
  return (['cpu', 'memory'] as const).map(metric => ({
    id: metric, header: metric === 'cpu' ? 'CPU' : 'MEMORY', align: 'right',
    sortValue: object => snapshot?.items?.[object.metadata?.uid]?.usage?.[metric] ?? -1,
    value: object => {
      const w = snapshot?.items?.[object.metadata?.uid]
      return <Stack direction="row" sx={{ flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 0.75 }} title={w ? coverage(w, object.kind === 'Deployment') : 'Metrics unavailable'}>
        <span style={{ whiteSpace: 'nowrap' }}>{formatUsage(w?.usage?.[metric], metric)}{w && w.reporting < w.expected && w.usage ? ' *' : ''}</span>
        {w && snapshot && <UsageChart points={w.history} metric={metric} now={snapshot.time} compact />}
      </Stack>
    },
  }))
}

export function MetricsDetails({ workload, snapshot, deployment, error }: {
  workload?: WorkloadMetrics; snapshot?: MetricsSnapshot; deployment: boolean; error?: string
}) {
  const rows: (ContainerMetrics & Partial<Pick<WorkloadMetrics, 'reporting' | 'expected'>>)[] = deployment
    ? (workload?.pods || []).flatMap(uid => snapshot?.pods?.[uid] ? [snapshot.pods[uid]] : [])
    : workload?.containers || []
  return <Box sx={{ p: 2, overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>
    {error && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
    {!workload && !error && <Alert severity="info">Waiting for metrics...</Alert>}
    {workload && snapshot && <>
      <Typography variant="body2" sx={{ mb: 1 }}>{coverage(workload, deployment)}. {workload.updated ? `Last sample: ${new Date(workload.updated).toLocaleTimeString()}.` : 'No current sample.'} History builds while this context is viewed; up to 15 minutes is kept in memory.</Typography>
      {workload.reporting < workload.expected && <Alert severity="info" sx={{ mb: 1 }}>Usage is incomplete. Missing or stale {deployment ? 'pods' : 'containers'} are excluded from totals.</Alert>}
      {deployment && <Typography variant="body2" sx={{ mb: 1 }}>Average per reporting pod: CPU {formatUsage(workload.usage && workload.reporting ? workload.usage.cpu / workload.reporting : undefined, 'cpu')}; memory {formatUsage(workload.usage && workload.reporting ? workload.usage.memory / workload.reporting : undefined, 'memory')}.</Typography>}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        {(['cpu', 'memory'] as const).map(metric => <Box key={metric} sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2">{metric === 'cpu' ? 'CPU' : 'Memory'}: {formatUsage(workload.usage?.[metric], metric)}</Typography>
          <UsageChart points={workload.history} metric={metric} now={snapshot.time} request={workload.requests[metric]} limit={workload.limits[metric]} />
        </Box>)}
      </Stack>
      <Typography variant="caption" color="text.secondary">Requests and limits are sums of configured values; an unset limit is not a zero limit. CPU is sampled average usage; memory is working set.</Typography>
      <TableContainer><Table size="small" aria-label={deployment ? 'Pod metrics' : 'Container metrics'}>
        <TableHead><TableRow><TableCell>{deployment ? 'Pod' : 'Container'}</TableCell>{['CPU', 'Memory', 'CPU request', 'Memory request', 'CPU limit', 'Memory limit'].map(label => <TableCell key={label} align="right">{label}</TableCell>)}</TableRow></TableHead>
        <TableBody>{rows.map(row => <TableRow key={row.name}>
          <TableCell>{row.name}{deployment && <Typography variant="caption" component="div" color="text.secondary">{row.reporting} of {row.expected} containers reporting</Typography>}</TableCell>
          {(['usage', 'requests', 'limits'] as const).flatMap(field => (['cpu', 'memory'] as const).map(metric => <TableCell key={`${field}-${metric}`} align="right">{formatConfigured(row, field, metric)}</TableCell>))}
        </TableRow>)}</TableBody>
      </Table></TableContainer>
    </>}
  </Box>
}
function formatConfigured(row: ContainerMetrics, field: 'usage' | 'requests' | 'limits', metric: keyof Usage) {
  const value = row[field]?.[metric]
  return formatUsage(field !== 'usage' && !value ? undefined : value, metric)
}
