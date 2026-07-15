import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, CircularProgress } from '@mui/material'
import { BackendLogToasts } from './BackendLogToasts'
import { DetailsDrawer } from './DetailsDrawer'
import { ResourceFilters } from './ResourceFilters'
import { ResourceTable } from './ResourceTable'
import { useBackendLogs } from '../hooks/useBackendLogs'
import { useHelmHistory } from '../hooks/useHelmHistory'
import { useResourceEvents } from '../hooks/useResourceEvents'
import { useResourceLogs } from '../hooks/useResourceLogs'
import { useResourceStream } from '../hooks/useResourceStream'
import {
  cleanKubernetesObject,
  columnsByResource,
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
} from '../resources'
import type { DetailsTab, SortState, TableFilters } from '../types'

type KubeWatchBodyProps = {
  ctx: string
  resource: string
}

export function KubeWatchBody({ ctx, resource }: KubeWatchBodyProps) {
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
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const columns = columnsByResource[resource] || columnsByResource.pods
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
        selection={{
          item: selectedItem,
          key: selectedKey,
          resource,
          detailsItem,
          panelRef: detailsPanelRef,
          onClose: () => {
            setSelectedKey(null)
            setShowFullDetails(false)
            setDetailsTab('yaml')
          },
        }}
        tabs={{
          active: detailsTab,
          onChange: setDetailsTab,
          supportsEvents,
          supportsLogs,
          supportsHistory,
        }}
        yaml={{
          showFull: showFullDetails,
          onToggleFull: () => setShowFullDetails(prev => !prev),
        }}
        events={{
          columns: columnsByResource.events,
          items: sortedSelectedEvents,
          loading: eventsLoading,
          error: eventsError,
          now,
          objectKey,
        }}
        history={{
          items: helmHistory,
          loading: helmHistoryLoading,
          error: helmHistoryError,
          now,
        }}
        logs={{
          detailsRef: logDetailsRef,
          tailLines: logTailLines,
          onTailLinesChange: setLogTailLines,
          autoScroll: autoScrollLogs,
          onToggleAutoScroll: () => setAutoScrollLogs(prev => !prev),
          containers: logContainers,
          activeContainer: activeLogContainer,
          onActiveContainerChange: setActiveLogContainer,
          loading: logsLoading,
          error: logsError,
          entries: sortedLogEntries,
        }}
        formatters={{
          formatDurationSince,
          formatLogTimestamp,
          logEntryKey,
        }}
      />
    </Box>
  )
}
