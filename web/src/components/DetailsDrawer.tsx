import CloseIcon from '@mui/icons-material/Close'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import type { RefObject } from 'react'
import { stringify } from 'yaml'
import { JsonLogMessage } from './JsonLogMessage'
import { RelativeAge } from './RelativeAge'
import type { Column, DetailsTab, LogEntry } from '../types'

const maximumHighlightedLogEntries = 200

type DetailsSelection = {
  item: any
  key: string | null
  resource: string
  detailsItem: any
  panelRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}

type DetailsTabs = {
  active: DetailsTab
  onChange: (tab: DetailsTab) => void
  supportsEvents: boolean
  supportsLogs: boolean
  supportsHistory: boolean
}

type YamlDetails = {
  showFull: boolean
  onToggleFull: () => void
}

type EventsDetails = {
  columns: Column[]
  items: any[]
  loading: boolean
  error: string | null
  objectKey: (object: any) => string
}

type HistoryDetails = {
  items: any[]
  loading: boolean
  error: string | null
}

type LogsDetails = {
  detailsRef: RefObject<HTMLDivElement | null>
  tailLines: number
  onTailLinesChange: (value: number) => void
  autoScroll: boolean
  onToggleAutoScroll: () => void
  containers: string[]
  activeContainer: string
  onActiveContainerChange: (container: string) => void
  loading: boolean
  error: string | null
  entries: LogEntry[]
}

type DetailsFormatters = {
  formatLogTimestamp: (timestamp: string) => string
  logEntryKey: (entry: LogEntry) => string
}

type DetailsDrawerProps = {
  selection: DetailsSelection
  tabs: DetailsTabs
  yaml: YamlDetails
  events: EventsDetails
  history: HistoryDetails
  logs: LogsDetails
  formatters: DetailsFormatters
}

export function DetailsDrawer({
  selection,
  tabs,
  yaml,
  events,
  history,
  logs,
  formatters,
}: DetailsDrawerProps) {
  const { item, key, resource, detailsItem, panelRef, onClose } = selection

  return (
    <Drawer
      anchor="bottom"
      open={Boolean(item)}
      variant="persistent"
      slotProps={{
        paper: {
          ref: panelRef,
          className: 'details-panel',
          sx: {
            right: 12,
            bottom: 12,
            left: 12,
            width: 'auto',
            maxHeight: '42vh',
            borderRadius: 2,
            overflow: 'hidden',
          },
        },
      }}
    >
      {item && (
        <Box component="section" aria-label="Selected resource details">
          <Box className="details-header">
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              {item.kind || resource}/{item.metadata?.name || key}
            </Typography>
            <Stack direction="row" spacing={1}>
              {tabs.active === 'yaml' && (
                <Button size="small" variant="outlined" type="button" onClick={yaml.onToggleFull}>
                  {yaml.showFull ? 'Hide housekeeping' : 'Show full YAML'}
                </Button>
              )}
              <Tooltip title="Close details">
                <IconButton size="small" type="button" aria-label="Close" onClick={onClose}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>
          <Tabs value={tabs.active} onChange={(_, value: DetailsTab) => tabs.onChange(value)} sx={{ px: 1.5 }}>
            <Tab value="yaml" label="YAML" />
            {tabs.supportsEvents && <Tab value="events" label="Events" />}
            {tabs.supportsLogs && <Tab value="logs" label="Logs" />}
            {tabs.supportsHistory && <Tab value="history" label="History" />}
          </Tabs>
          {tabs.active === 'yaml' && <pre>{stringify(detailsItem)}</pre>}
          {tabs.active === 'history' && tabs.supportsHistory && (
            <HistoryTab details={history} />
          )}
          {tabs.active === 'events' && tabs.supportsEvents && <EventsTab details={events} />}
          {tabs.active === 'logs' && tabs.supportsLogs && (
            <LogsTab
              resource={resource}
              details={logs}
              formatLogTimestamp={formatters.formatLogTimestamp}
              logEntryKey={formatters.logEntryKey}
            />
          )}
        </Box>
      )}
    </Drawer>
  )
}

function HistoryTab({
  details,
}: {
  details: HistoryDetails
}) {
  return (
    <Box className="event-details">
      {details.loading && (
        <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
          Loading history...
        </Alert>
      )}
      {details.error && <Alert severity="error" className="inline-error">{details.error}</Alert>}
      {!details.loading && details.items.length === 0 && !details.error && (
        <Alert severity="info" className="empty-state">No history found for this release.</Alert>
      )}
      {details.items.length > 0 && (
        <TableContainer component={Paper} sx={{ border: 1, borderColor: 'divider', maxHeight: '28vh' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell align="right">REVISION</TableCell>
                <TableCell>STATUS</TableCell>
                <TableCell>CHART</TableCell>
                <TableCell>APP VERSION</TableCell>
                <TableCell align="right">UPDATED</TableCell>
                <TableCell>DESCRIPTION</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {details.items.map((revision: any) => (
                <TableRow key={revision.revision}>
                  <TableCell align="right">{revision.revision}</TableCell>
                  <TableCell>{revision.status || ''}</TableCell>
                  <TableCell>{[revision.chart, revision.version].filter(Boolean).join('-')}</TableCell>
                  <TableCell>{revision.appVersion || ''}</TableCell>
                  <TableCell align="right"><RelativeAge timestamp={revision.updated} /></TableCell>
                  <TableCell>{revision.description || ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  )
}

function EventsTab({ details }: { details: EventsDetails }) {
  return (
    <Box className="event-details">
      {details.loading && (
        <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
          Loading events...
        </Alert>
      )}
      {details.error && <Alert severity="error" className="inline-error">{details.error}</Alert>}
      {!details.loading && details.items.length === 0 && !details.error && (
        <Alert severity="info" className="empty-state">No events found for this resource.</Alert>
      )}
      {details.items.length > 0 && (
        <TableContainer component={Paper} sx={{ border: 1, borderColor: 'divider', maxHeight: '28vh' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {details.columns.map(column => (
                  <TableCell key={column.id} align={column.align}>{column.header}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {details.items.map((event: any) => (
                <TableRow key={details.objectKey(event)}>
                  {details.columns.map(column => (
                    <TableCell key={column.id} align={column.align}>{column.value(event)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  )
}

function LogsTab({
  resource,
  details,
  formatLogTimestamp,
  logEntryKey,
}: {
  resource: string
  details: LogsDetails
  formatLogTimestamp: DetailsFormatters['formatLogTimestamp']
  logEntryKey: DetailsFormatters['logEntryKey']
}) {
  return (
    <Box ref={details.detailsRef} className="log-details">
      <Box
        className="log-controls"
        sx={{
          bgcolor: 'background.paper',
          borderColor: 'divider',
          boxShadow: theme => `0 1px 0 ${theme.palette.divider}`,
        }}
      >
        <Stack direction="row" spacing={1.5} className="log-options" sx={{ alignItems: 'center' }}>
          <TextField
            label="Tail lines"
            type="number"
            size="small"
            value={details.tailLines}
            slotProps={{ htmlInput: { min: 0, max: 5000 } }}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10)
              if (Number.isFinite(next)) {
                details.onTailLinesChange(Math.max(0, Math.min(5000, next)))
              }
            }}
            sx={{ width: 120 }}
          />
          <Chip size="small" label="Live follow" />
          <Button size="small" variant="outlined" type="button" onClick={details.onToggleAutoScroll}>
            Auto scroll {details.autoScroll ? 'on' : 'off'}
          </Button>
        </Stack>
        {details.containers.length > 0 && (
          <Tabs
            className="container-tabs"
            value={details.activeContainer}
            onChange={(_, value: string) => details.onActiveContainerChange(value)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label="Log containers"
          >
            {details.containers.map(container => (
              <Tab key={container} value={container} label={container} />
            ))}
          </Tabs>
        )}
      </Box>
      {details.loading && (
        <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
          Loading logs...
        </Alert>
      )}
      {details.error && <Alert severity="error" className="inline-error">{details.error}</Alert>}
      {!details.loading && !details.error && details.containers.length === 0 && (
        <Alert severity="info" className="empty-state">No containers found for this {resource === 'pods' ? 'pod' : 'deployment'}.</Alert>
      )}
      {!details.loading && !details.error && details.containers.length > 0 && details.entries.length === 0 && (
        <Alert severity="info" className="empty-state">Waiting for log lines for container {details.activeContainer}...</Alert>
      )}
      {details.entries.length > 0 && (
        <Box
          className="log-output"
          aria-label={`Logs for ${details.activeContainer}`}
          sx={{
            bgcolor: 'background.paper',
            color: 'text.primary',
            borderColor: 'divider',
          }}
        >
          {details.entries.map((entry, index) => (
            <Box key={logEntryKey(entry)} className="log-line">
              <span className="log-time">{formatLogTimestamp(entry.timestamp)} </span>
              <span className="log-pod">{entry.pod}: </span>
              <span className="log-message">
                <JsonLogMessage
                  line={entry.line}
                  highlight={index >= details.entries.length - maximumHighlightedLogEntries}
                />
              </span>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
