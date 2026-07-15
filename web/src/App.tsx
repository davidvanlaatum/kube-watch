import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
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
import { useHelmHistory } from './hooks/useHelmHistory'
import { useResourceEvents } from './hooks/useResourceEvents'
import { useResourceLogs } from './hooks/useResourceLogs'
import { useResourceStream } from './hooks/useResourceStream'
import { useViewRoute } from './hooks/useViewRoute'
import {
  cleanKubernetesObject,
  columnsByResource,
  contextSelectOptions,
  emptyFilters,
  eventSupportedResources,
  formatDurationSince,
  formatLogTimestamp,
  hasActiveFilters,
  labelSuggestions,
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('yaml')
  const [showFullDetails, setShowFullDetails] = useState(false)
  const [logTailLines, setLogTailLines] = useState(200)
  const { logs: backendLogs, dismissLog: dismissBackendLog } = useBackendLogs()
  const detailsPanelRef = useRef<HTMLDivElement | null>(null)
  const [detailsOffset, setDetailsOffset] = useState(0)

  const resetResourceViewState = useCallback(() => {
    setFilters(emptyFilters)
    setSelectedKey(null)
    setDetailsTab('yaml')
    setShowFullDetails(false)
    setSort(null)
  }, [])

  const handleSelectedResourceDeleted = useCallback((key: string) => {
    setSelectedKey(prev => {
      if (prev === key) {
        setShowFullDetails(false)
        setDetailsTab('yaml')
        return null
      }
      return prev
    })
  }, [])

  const { items, isLoading, loadError } = useResourceStream(ctx, resource, {
    onReset: resetResourceViewState,
    onSelectedDeleted: handleSelectedResourceDeleted,
  })

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

  const columns = columnsByResource[resource] || columnsByResource.pods
  const contextOptions = contextSelectOptions(contexts, ctx)
  const allItems = [...items.values()]
  const labelFilterSuggestions = useMemo(() => labelSuggestions(allItems), [allItems])
  const showStatusFilter = supportsStatusFilter(resource)
  const statusFilterSuggestions = useMemo(() => statusSuggestions(resource, allItems), [resource, allItems])
  const filteredItems = allItems.filter(item => matchesFilters(resource, item, filters))
  const sortedItems = sortItems(resource, filteredItems, sort)
  const selectedItem = selectedKey ? items.get(selectedKey) : null
  const {
    history: helmHistory,
    loading: helmHistoryLoading,
    error: helmHistoryError,
  } = useHelmHistory(ctx, resource, selectedItem, detailsTab)
  const detailsItem = selectedItem && (showFullDetails ? selectedItem : cleanKubernetesObject(selectedItem))
  const supportsEvents = Boolean(selectedItem && eventSupportedResources.has(resource))
  const {
    sortedEvents: sortedSelectedEvents,
    loading: eventsLoading,
    error: eventsError,
  } = useResourceEvents(ctx, resource, selectedItem, supportsEvents)
  const supportsLogs = Boolean(selectedItem && logSupportedResources.has(resource))
  const {
    detailsRef: logDetailsRef,
    containers: logContainers,
    activeContainer: activeLogContainer,
    setActiveContainer: setActiveLogContainer,
    autoScroll: autoScrollLogs,
    setAutoScroll: setAutoScrollLogs,
    loading: logsLoading,
    error: logsError,
    sortedEntries: sortedLogEntries,
    entryCount: logEntryCount,
  } = useResourceLogs({
    ctx,
    resource,
    selectedItem,
    supportsLogs,
    detailsTab,
    tailLines: logTailLines,
  })
  const supportsHistory = Boolean(selectedItem && resource === 'helmreleases')

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
  }, [selectedItem, detailsTab, showFullDetails, helmHistory.length, helmHistoryLoading, logEntryCount, sortedSelectedEvents.length])

  useEffect(() => {
    if (!showStatusFilter && filters.status) {
      setFilters(prev => ({ ...prev, status: '' }))
    }
  }, [filters.status, showStatusFilter])

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
