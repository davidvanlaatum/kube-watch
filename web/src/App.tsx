import { useEffect, useMemo, useState, useRef } from 'react'
import {
  Alert,
  Box,
  CircularProgress,
  CssBaseline,
  ThemeProvider,
  createTheme,
} from '@mui/material'
import { AppHeader } from './components/AppHeader'
import { BackendLogToasts } from './components/BackendLogToasts'
import { DetailsDrawer } from './components/DetailsDrawer'
import { ResourceFilters } from './components/ResourceFilters'
import { ResourceTable } from './components/ResourceTable'
import { useBackendLogs } from './hooks/useBackendLogs'
import { useViewRoute } from './hooks/useViewRoute'
import {
  cleanKubernetesObject,
  columnsByResource,
  contextSelectOptions,
  emptyFilters,
  eventMatchesResource,
  eventSupportedResources,
  formatDurationSince,
  formatLogTimestamp,
  hasActiveFilters,
  labelSuggestions,
  logContainerNames,
  logEntryKey,
  logSupportedResources,
  matchesFilters,
  nextSort,
  objectKey,
  sortItems,
  statusSuggestions,
  supportsStatusFilter,
  versionLabel,
} from './resources'
import type {
  ContextInfo,
  DetailsTab,
  Envelope,
  LogEntry,
  LogEnvelope,
  SortState,
  TableFilters,
  VersionInfo,
} from './types'

const prefersDarkMode = typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const theme = createTheme({
  palette: {
    mode: prefersDarkMode ? 'dark' : 'light',
    primary: {
      main: '#2563eb',
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
  },
  components: {
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        },
        body: {
          fontSize: 13,
        },
      },
    },
    MuiTooltip: {
      defaultProps: {
        arrow: true,
      },
    },
  },
})

export default function App() {
  const { ctx, setCtx, resource, setResource } = useViewRoute()
  const [contexts, setContexts] = useState<ContextInfo[]>([])
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [now, setNow] = useState(Date.now())
  const [filters, setFilters] = useState<TableFilters>(emptyFilters)
  const [sort, setSort] = useState<SortState>(null)
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('yaml')
  const [showFullDetails, setShowFullDetails] = useState(false)
  const [selectedEvents, setSelectedEvents] = useState<Map<string, any>>(new Map())
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [helmHistory, setHelmHistory] = useState<any[]>([])
  const [helmHistoryLoading, setHelmHistoryLoading] = useState(false)
  const [helmHistoryError, setHelmHistoryError] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [activeLogContainer, setActiveLogContainer] = useState<string>('')
  const [logTailLines, setLogTailLines] = useState(200)
  const [autoScrollLogs, setAutoScrollLogs] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { logs: backendLogs, dismissLog: dismissBackendLog } = useBackendLogs()
  const esRef = useRef<EventSource | null>(null)
  const eventsEsRef = useRef<EventSource | null>(null)
  const logsEsRef = useRef<EventSource | null>(null)
  const logDetailsRef = useRef<HTMLDivElement | null>(null)
  const detailsPanelRef = useRef<HTMLDivElement | null>(null)
  const [detailsOffset, setDetailsOffset] = useState(0)

  useEffect(() => {
    fetch('/api/contexts').then(r => r.json()).then(setContexts).catch(console.error)
  }, [])

  useEffect(() => {
    const fetchVersion = () => {
      fetch('/api/version').then(r => r.json()).then(setVersionInfo).catch(console.error)
    }
    fetchVersion()
    const id = window.setInterval(fetchVersion, 60 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!ctx) return
    // close existing
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setItems(new Map())
    setFilters(emptyFilters)
    setSelectedKey(null)
    setDetailsTab('yaml')
    setShowFullDetails(false)
    setLogEntries([])
    setLogsError(null)
    setHelmHistory([])
    setHelmHistoryError(null)
    setHelmHistoryLoading(false)
    setActiveLogContainer('')
    setSort(null)
    setIsLoading(true)
    setLoadError(null)
    const url = `/sse/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        } else if (env.type === 'DELETED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
          setSelectedKey(prev => {
            if (prev === uid) {
              setShowFullDetails(false)
              setDetailsTab('yaml')
              setHelmHistory([])
              setHelmHistoryError(null)
              return null
            }
            return prev
          })
        } else if (env.type === 'SYNCED') {
          setIsLoading(false)
          setLoadError(null)
        } else if (env.error) {
          setIsLoading(false)
          setLoadError(env.error)
          console.warn('sse error', env)
        }
      } catch (e) {
        console.warn('sse parse', e)
      }
    }
    es.onerror = (e) => {
      setLoadError('Connection interrupted; waiting for EventSource to reconnect')
      console.warn('sse error', e)
    }
    esRef.current = es
    return () => {
      es.close()
      esRef.current = null
    }
  }, [ctx, resource])

  const columns = columnsByResource[resource] || columnsByResource.pods
  const contextOptions = contextSelectOptions(contexts, ctx)
  const allItems = [...items.values()]
  const labelFilterSuggestions = useMemo(() => labelSuggestions(allItems), [allItems])
  const showStatusFilter = supportsStatusFilter(resource)
  const statusFilterSuggestions = useMemo(() => statusSuggestions(resource, allItems), [resource, allItems])
  const filteredItems = allItems.filter(item => matchesFilters(resource, item, filters))
  const sortedItems = sortItems(resource, filteredItems, sort)
  const selectedItem = selectedKey ? items.get(selectedKey) : null
  const detailsItem = selectedItem && (showFullDetails ? selectedItem : cleanKubernetesObject(selectedItem))
  const supportsEvents = Boolean(selectedItem && eventSupportedResources.has(resource))
  const supportsLogs = Boolean(selectedItem && logSupportedResources.has(resource))
  const supportsHistory = Boolean(selectedItem && resource === 'helmreleases')
  const sortedSelectedEvents = sortItems('events', [...selectedEvents.values()], null)
  const selectedName = selectedItem?.metadata?.name || ''
  const selectedNamespace = selectedItem?.metadata?.namespace || ''
  const logContainers = useMemo(
    () => selectedItem ? logContainerNames(selectedItem, resource, logEntries) : [],
    [selectedItem, resource, logEntries],
  )
  const logContainersKey = logContainers.join('\u0000')
  const sortedLogEntries = useMemo(() => {
    return logEntries
      .filter(entry => entry.container === activeLogContainer)
      .sort((a, b) => {
        const timeCompare = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        if (timeCompare !== 0) return timeCompare
        if (a.pod !== b.pod) return a.pod.localeCompare(b.pod)
        return a.seq - b.seq
      })
  }, [logEntries, activeLogContainer])

  useEffect(() => {
    if (!selectedItem || !detailsPanelRef.current) {
      setDetailsOffset(0)
      return
    }

    const updateDetailsOffset = () => {
      const height = detailsPanelRef.current?.getBoundingClientRect().height || 0
      setDetailsOffset(Math.ceil(height + 24))
    }
    updateDetailsOffset()

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateDetailsOffset)
      observer.observe(detailsPanelRef.current)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateDetailsOffset)
    return () => window.removeEventListener('resize', updateDetailsOffset)
  }, [selectedItem, detailsTab, showFullDetails, helmHistory.length, helmHistoryLoading, logEntries.length, sortedSelectedEvents.length])

  useEffect(() => {
    if (!showStatusFilter && filters.status) {
      setFilters(prev => ({ ...prev, status: '' }))
    }
  }, [filters.status, showStatusFilter])

  useEffect(() => {
    setHelmHistory([])
    setHelmHistoryError(null)

    if (!ctx || !selectedItem || resource !== 'helmreleases' || detailsTab !== 'history') {
      setHelmHistoryLoading(false)
      return
    }

    const driver = selectedItem.status?.storageDriver || 'secrets'
    const releaseName = selectedItem.metadata?.name || ''
    if (!releaseName) {
      setHelmHistoryLoading(false)
      return
    }

    const controller = new AbortController()
    setHelmHistoryLoading(true)
    fetch(`/api/helm-history/${encodeURIComponent(ctx)}/${encodeURIComponent(driver)}/${encodeURIComponent(releaseName)}`, {
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) {
        throw new Error(await response.text() || `Helm history failed with ${response.status}`)
      }
      return response.json()
    }).then(history => {
      setHelmHistory(Array.isArray(history) ? history : [])
      setHelmHistoryError(null)
    }).catch(error => {
      if (error.name === 'AbortError') return
      setHelmHistoryError(error.message || String(error))
    }).finally(() => {
      if (!controller.signal.aborted) {
        setHelmHistoryLoading(false)
      }
    })

    return () => controller.abort()
  }, [ctx, resource, selectedItem, detailsTab])

  useEffect(() => {
    if (eventsEsRef.current) {
      eventsEsRef.current.close()
      eventsEsRef.current = null
    }
    setSelectedEvents(new Map())
    setEventsError(null)

    if (!ctx || !selectedItem || !supportsEvents) {
      setEventsLoading(false)
      return
    }

    setEventsLoading(true)
    const selected = selectedItem
    const es = new EventSource(`/sse/${encodeURIComponent(ctx)}/events`)
    const emptyEventsTimer = window.setTimeout(() => {
      setEventsLoading(false)
    }, 2500)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'SYNCED') {
          window.clearTimeout(emptyEventsTimer)
          setEventsLoading(false)
          return
        }
        if (env.error) {
          window.clearTimeout(emptyEventsTimer)
          setEventsLoading(false)
          setEventsError(env.error)
          return
        }
        if (!env.object || !eventMatchesResource(env.object, selected, resource)) {
          return
        }
        window.clearTimeout(emptyEventsTimer)
        setEventsLoading(false)
        setEventsError(null)
        const uid = objectKey(env.object)
        if (env.type === 'DELETED') {
          setSelectedEvents(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
          return
        }
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          setSelectedEvents(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        }
      } catch (e) {
        console.warn('event stream parse', e)
      }
    }
    es.onerror = (e) => {
      window.clearTimeout(emptyEventsTimer)
      setEventsLoading(false)
      setEventsError('Event stream interrupted; waiting for EventSource to reconnect')
      console.warn('event stream error', e)
    }
    eventsEsRef.current = es
    return () => {
      window.clearTimeout(emptyEventsTimer)
      es.close()
      eventsEsRef.current = null
    }
  }, [ctx, resource, selectedItem, supportsEvents])

  useEffect(() => {
    if (!logContainers.includes(activeLogContainer)) {
      setActiveLogContainer(logContainers[0] || '')
    }
  }, [activeLogContainer, logContainers, logContainersKey])

  useEffect(() => {
    if (logsEsRef.current) {
      logsEsRef.current.close()
      logsEsRef.current = null
    }
    setLogEntries([])
    setLogsError(null)

    if (!ctx || !selectedName || !selectedNamespace || !supportsLogs || detailsTab !== 'logs') {
      setLogsLoading(false)
      return
    }

    setLogsLoading(true)
    const url = `/logs/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}/${encodeURIComponent(selectedNamespace)}/${encodeURIComponent(selectedName)}?tailLines=${encodeURIComponent(String(logTailLines))}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: LogEnvelope = JSON.parse(ev.data)
        if (env.type === 'LOG' && env.pod && env.container && env.line !== undefined) {
          setLogsLoading(false)
          setLogsError(null)
          const entry: LogEntry = {
            pod: env.pod,
            container: env.container,
            timestamp: env.timestamp || new Date().toISOString(),
            line: env.line,
            seq: env.seq || 0,
          }
          setLogEntries(prev => {
            const key = logEntryKey(entry)
            if (prev.some(existing => logEntryKey(existing) === key)) return prev
            return [...prev, entry].slice(-10000)
          })
          return
        }
        if (env.type === 'INFO') {
          return
        }
        if (env.type === 'ERROR' || env.error) {
          setLogsLoading(false)
          setLogsError(env.error || 'Log stream error')
        }
      } catch (e) {
        console.warn('log stream parse', e)
      }
    }
    es.onerror = (e) => {
      setLogsLoading(false)
      setLogsError('Log stream interrupted; waiting for EventSource to reconnect')
      console.warn('log stream error', e)
    }
    logsEsRef.current = es
    return () => {
      es.close()
      logsEsRef.current = null
    }
  }, [ctx, resource, selectedName, selectedNamespace, supportsLogs, detailsTab, logTailLines])

  useEffect(() => {
    if (!autoScrollLogs || !logDetailsRef.current) return
    logDetailsRef.current.scrollTop = logDetailsRef.current.scrollHeight
  }, [autoScrollLogs, sortedLogEntries.length, activeLogContainer])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className="app" sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <AppHeader
          versionInfo={versionInfo}
          versionLabel={versionLabel}
          contexts={contextOptions}
          ctx={ctx}
          resource={resource}
          onContextChange={setCtx}
          onResourceChange={setResource}
        />
        <Box component="main" className={selectedItem ? 'has-details' : undefined} sx={{ p: 2, pb: selectedItem ? `${detailsOffset + 16}px` : 2 }}>
          {isLoading && (
            <Alert icon={<CircularProgress size={16} />} severity="info" role="status" sx={{ mb: 2 }}>
              Loading {resource}...
            </Alert>
          )}
          <BackendLogToasts logs={backendLogs} onDismiss={dismissBackendLog} />
          {loadError && !isLoading && <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>}
          <ResourceFilters
            resource={resource}
            filters={filters}
            showStatusFilter={showStatusFilter}
            statusFilterSuggestions={statusFilterSuggestions}
            labelFilterSuggestions={labelFilterSuggestions}
            shownCount={sortedItems.length}
            totalCount={allItems.length}
            hasActiveFilters={hasActiveFilters(filters)}
            onFiltersChange={setFilters}
            onClearFilters={() => setFilters(emptyFilters)}
          />
          <ResourceTable
            columns={columns}
            items={sortedItems}
            now={now}
            selectedKey={selectedKey}
            detailsOffset={detailsOffset}
            hasSelectedItem={Boolean(selectedItem)}
            sort={sort}
            objectKey={objectKey}
            nextSort={nextSort}
            onSortChange={setSort}
            onSelectKey={setSelectedKey}
            onSelectionChanged={() => {
              setShowFullDetails(false)
              setDetailsTab('yaml')
              setLogEntries([])
              setLogsError(null)
              setHelmHistory([])
              setHelmHistoryError(null)
              setActiveLogContainer('')
            }}
          />
          <DetailsDrawer
            selectedItem={selectedItem}
            selectedKey={selectedKey}
            resource={resource}
            detailsItem={detailsItem}
            detailsPanelRef={detailsPanelRef}
            detailsTab={detailsTab}
            setDetailsTab={setDetailsTab}
            showFullDetails={showFullDetails}
            setShowFullDetails={setShowFullDetails}
            setSelectedKey={setSelectedKey}
            supportsEvents={supportsEvents}
            supportsLogs={supportsLogs}
            supportsHistory={supportsHistory}
            now={now}
            columnsByResource={columnsByResource}
            objectKey={objectKey}
            sortedSelectedEvents={sortedSelectedEvents}
            eventsLoading={eventsLoading}
            eventsError={eventsError}
            helmHistory={helmHistory}
            helmHistoryLoading={helmHistoryLoading}
            helmHistoryError={helmHistoryError}
            logDetailsRef={logDetailsRef}
            logTailLines={logTailLines}
            setLogTailLines={setLogTailLines}
            autoScrollLogs={autoScrollLogs}
            setAutoScrollLogs={setAutoScrollLogs}
            logContainers={logContainers}
            activeLogContainer={activeLogContainer}
            setActiveLogContainer={setActiveLogContainer}
            logsLoading={logsLoading}
            logsError={logsError}
            sortedLogEntries={sortedLogEntries}
            formatDurationSince={formatDurationSince}
            formatLogTimestamp={formatLogTimestamp}
            logEntryKey={logEntryKey}
          />
        </Box>
      </Box>
    </ThemeProvider>
  )
}
