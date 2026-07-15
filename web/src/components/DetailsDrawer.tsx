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
import CloseIcon from '@mui/icons-material/Close'
import { stringify } from 'yaml'
import type { RefObject } from 'react'
import type { Column, DetailsTab, LogEntry } from '../types'

type DetailsDrawerProps = {
  selectedItem: any
  selectedKey: string | null
  resource: string
  detailsItem: any
  detailsPanelRef: RefObject<HTMLDivElement | null>
  detailsTab: DetailsTab
  setDetailsTab: (tab: DetailsTab) => void
  showFullDetails: boolean
  setShowFullDetails: (updater: (value: boolean) => boolean) => void
  setSelectedKey: (key: string | null) => void
  supportsEvents: boolean
  supportsLogs: boolean
  supportsHistory: boolean
  now: number
  columnsByResource: Record<string, Column[]>
  objectKey: (object: any) => string
  sortedSelectedEvents: any[]
  eventsLoading: boolean
  eventsError: string | null
  helmHistory: any[]
  helmHistoryLoading: boolean
  helmHistoryError: string | null
  logDetailsRef: RefObject<HTMLDivElement | null>
  logTailLines: number
  setLogTailLines: (value: number) => void
  autoScrollLogs: boolean
  setAutoScrollLogs: (updater: (value: boolean) => boolean) => void
  logContainers: string[]
  activeLogContainer: string
  setActiveLogContainer: (container: string) => void
  logsLoading: boolean
  logsError: string | null
  sortedLogEntries: LogEntry[]
  formatDurationSince: (timestamp: string | undefined, now?: number) => React.ReactNode
  formatLogTimestamp: (timestamp: string) => string
  logEntryKey: (entry: LogEntry) => string
}

export function DetailsDrawer({
  selectedItem,
  selectedKey,
  resource,
  detailsItem,
  detailsPanelRef,
  detailsTab,
  setDetailsTab,
  showFullDetails,
  setShowFullDetails,
  setSelectedKey,
  supportsEvents,
  supportsLogs,
  supportsHistory,
  now,
  columnsByResource,
  objectKey,
  sortedSelectedEvents,
  eventsLoading,
  eventsError,
  helmHistory,
  helmHistoryLoading,
  helmHistoryError,
  logDetailsRef,
  logTailLines,
  setLogTailLines,
  autoScrollLogs,
  setAutoScrollLogs,
  logContainers,
  activeLogContainer,
  setActiveLogContainer,
  logsLoading,
  logsError,
  sortedLogEntries,
  formatDurationSince,
  formatLogTimestamp,
  logEntryKey,
}: DetailsDrawerProps) {
  return (
    <Drawer
      anchor="bottom"
      open={Boolean(selectedItem)}
      variant="persistent"
      slotProps={{
        paper: {
          ref: detailsPanelRef,
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
      {selectedItem && (
        <Box component="section" aria-label="Selected resource details">
          <Box className="details-header">
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              {selectedItem.kind || resource}/{selectedItem.metadata?.name || selectedKey}
            </Typography>
            <Stack direction="row" spacing={1}>
              {detailsTab === 'yaml' && (
                <Button size="small" variant="outlined" type="button" onClick={() => setShowFullDetails(prev => !prev)}>
                  {showFullDetails ? 'Hide housekeeping' : 'Show full YAML'}
                </Button>
              )}
              <Tooltip title="Close details">
                <IconButton size="small" type="button" aria-label="Close" onClick={() => {
                  setSelectedKey(null)
                  setShowFullDetails(() => false)
                  setDetailsTab('yaml')
                }}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>
          <Tabs value={detailsTab} onChange={(_, value: DetailsTab) => setDetailsTab(value)} sx={{ px: 1.5 }}>
            <Tab value="yaml" label="YAML" />
            {supportsEvents && <Tab value="events" label="Events" />}
            {supportsLogs && <Tab value="logs" label="Logs" />}
            {supportsHistory && <Tab value="history" label="History" />}
          </Tabs>
          {detailsTab === 'yaml' && <pre>{stringify(detailsItem)}</pre>}
          {detailsTab === 'history' && supportsHistory && (
            <Box className="event-details">
              {helmHistoryLoading && (
                <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
                  Loading history...
                </Alert>
              )}
              {helmHistoryError && <Alert severity="error" className="inline-error">{helmHistoryError}</Alert>}
              {!helmHistoryLoading && helmHistory.length === 0 && !helmHistoryError && (
                <Alert severity="info" className="empty-state">No history found for this release.</Alert>
              )}
              {helmHistory.length > 0 && (
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
                      {helmHistory.map((revision: any) => (
                        <TableRow key={revision.revision}>
                          <TableCell align="right">{revision.revision}</TableCell>
                          <TableCell>{revision.status || ''}</TableCell>
                          <TableCell>{[revision.chart, revision.version].filter(Boolean).join('-')}</TableCell>
                          <TableCell>{revision.appVersion || ''}</TableCell>
                          <TableCell align="right">{formatDurationSince(revision.updated, now)}</TableCell>
                          <TableCell>{revision.description || ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          )}
          {detailsTab === 'events' && supportsEvents && (
            <Box className="event-details">
              {eventsLoading && (
                <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
                  Loading events...
                </Alert>
              )}
              {eventsError && <Alert severity="error" className="inline-error">{eventsError}</Alert>}
              {!eventsLoading && sortedSelectedEvents.length === 0 && !eventsError && (
                <Alert severity="info" className="empty-state">No events found for this resource.</Alert>
              )}
              {sortedSelectedEvents.length > 0 && (
                <TableContainer component={Paper} sx={{ border: 1, borderColor: 'divider', maxHeight: '28vh' }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        {columnsByResource.events.map(column => (
                          <TableCell key={column.header} align={column.align}>{column.header}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sortedSelectedEvents.map((event: any) => (
                        <TableRow key={objectKey(event)}>
                          {columnsByResource.events.map(column => (
                            <TableCell key={column.header} align={column.align}>{column.value(event, now)}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          )}
          {detailsTab === 'logs' && supportsLogs && (
            <Box ref={logDetailsRef} className="log-details">
              <Box className="log-controls">
                <Stack direction="row" spacing={1.5} className="log-options" sx={{ alignItems: 'center' }}>
                  <TextField
                    label="Tail lines"
                    type="number"
                    size="small"
                    value={logTailLines}
                    slotProps={{ htmlInput: { min: 0, max: 5000 } }}
                    onChange={(event) => {
                      const next = Number.parseInt(event.target.value, 10)
                      if (Number.isFinite(next)) {
                        setLogTailLines(Math.max(0, Math.min(5000, next)))
                      }
                    }}
                    sx={{ width: 120 }}
                  />
                  <Chip size="small" label="Live follow" />
                  <Button size="small" variant="outlined" type="button" onClick={() => setAutoScrollLogs(prev => !prev)}>
                    Auto scroll {autoScrollLogs ? 'on' : 'off'}
                  </Button>
                </Stack>
                {logContainers.length > 0 && (
                  <Tabs
                    className="container-tabs"
                    value={activeLogContainer}
                    onChange={(_, value: string) => setActiveLogContainer(value)}
                    variant="scrollable"
                    scrollButtons="auto"
                    aria-label="Log containers"
                  >
                    {logContainers.map(container => (
                      <Tab key={container} value={container} label={container} />
                    ))}
                  </Tabs>
                )}
              </Box>
              {logsLoading && (
                <Alert icon={<CircularProgress size={16} />} severity="info" className="inline-status">
                  Loading logs...
                </Alert>
              )}
              {logsError && <Alert severity="error" className="inline-error">{logsError}</Alert>}
              {!logsLoading && !logsError && logContainers.length === 0 && (
                <Alert severity="info" className="empty-state">No containers found for this {resource === 'pods' ? 'pod' : 'deployment'}.</Alert>
              )}
              {!logsLoading && !logsError && logContainers.length > 0 && sortedLogEntries.length === 0 && (
                <Alert severity="info" className="empty-state">Waiting for log lines for container {activeLogContainer}...</Alert>
              )}
              {sortedLogEntries.length > 0 && (
                <Box className="log-output" aria-label={`Logs for ${activeLogContainer}`}>
                  {sortedLogEntries.map(entry => (
                    <Box key={logEntryKey(entry)} className="log-line">
                      <span className="log-time">{formatLogTimestamp(entry.timestamp)} </span>
                      <span className="log-pod">{entry.pod}: </span>
                      <span className="log-message">{entry.line}</span>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}
    </Drawer>
  )
}
