import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Box, CircularProgress } from '@mui/material'
import { BackendLogToasts } from './BackendLogToasts'
import { DetailsDrawer } from './DetailsDrawer'
import { ResourceFilters } from './ResourceFilters'
import { ResourceTable } from './ResourceTable'
import { useBackendLogs } from '../hooks/useBackendLogs'
import { useDetailsPanelOffset } from '../hooks/useDetailsPanelOffset'
import { useDetailsState } from '../hooks/useDetailsState'
import { useHelmHistory } from '../hooks/useHelmHistory'
import { useResourceEvents } from '../hooks/useResourceEvents'
import { useResourceLogs } from '../hooks/useResourceLogs'
import { useResourceStream } from '../hooks/useResourceStream'
import { emptyFilters, hasActiveFilters, labelSuggestions, matchesFilters, statusSuggestions } from '../resourceFilters'
import { resourceDefinition, resourceRegistry } from '../resourceRegistry'
import { nextSort, sortItems } from '../resourceSort'
import { cleanKubernetesObject, formatLogTimestamp, logEntryKey, objectKey } from '../resourceUtils'
import type { DetailsTab, SortState, TableFilters } from '../types'

type KubeWatchBodyProps = {
  ctx: string
  resource: string
}

export function KubeWatchBody({ ctx, resource }: KubeWatchBodyProps) {
  const [filters, setFilters] = useState<TableFilters>(emptyFilters)
  const [sort, setSort] = useState<SortState>(null)
  const [logTailLines, setLogTailLines] = useState(200)
  const mainRef = useRef<HTMLElement | null>(null)
  const selectedKeyRef = useRef<string | null>(null)
  const { logs: backendLogs, dismissLog: dismissBackendLog } = useBackendLogs()
  const {
    selectedKey,
    setSelectedKey,
    detailsTab,
    setDetailsTab,
    showFullDetails,
    setShowFullDetails,
    isDetailsMaximized,
    setIsDetailsMaximized,
    resetDetailsView,
    closeDetails,
    handleSelectedResourceDeleted,
  } = useDetailsState()
  useEffect(() => {
    selectedKeyRef.current = selectedKey
  }, [selectedKey])

  const resetResourceViewState = useCallback(() => {
    setFilters(emptyFilters)
    closeDetails()
    setSort(null)
  }, [closeDetails])
  const restoreMainFocus = useCallback(() => {
    requestAnimationFrame(() => mainRef.current?.focus())
  }, [])
  const closeDetailsAndRestoreFocus = useCallback(() => {
    closeDetails()
    restoreMainFocus()
  }, [closeDetails, restoreMainFocus])
  const handleSelectedResourceDeletedAndRestoreFocus = useCallback((key: string) => {
    const wasSelected = selectedKeyRef.current === key
    handleSelectedResourceDeleted(key)
    if (wasSelected) restoreMainFocus()
  }, [handleSelectedResourceDeleted, restoreMainFocus])

  const { items, isLoading, loadError } = useResourceStream(ctx, resource, {
    onReset: resetResourceViewState,
    onSelectedDeleted: handleSelectedResourceDeletedAndRestoreFocus,
  })

  const definition = resourceDefinition(resource) || resourceRegistry.pods
  const columns = definition.columns
  const allItems = [...items.values()]
  const labelFilterSuggestions = useMemo(() => labelSuggestions(allItems), [allItems])
  const showStatusFilter = definition.supports.statusFilter
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
  const supportsEvents = Boolean(selectedItem && definition.supports.events)
  const {
    sortedEvents: sortedSelectedEvents,
    loading: eventsLoading,
    error: eventsError,
  } = useResourceEvents(ctx, resource, selectedItem, supportsEvents)
  const supportsLogs = Boolean(selectedItem && definition.supports.logs)
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
    isDetailsMaximized,
  })
  const supportsHistory = Boolean(selectedItem && definition.supports.history)
  const { panelRef: detailsPanelRef, offset: detailsOffset } = useDetailsPanelOffset({
    isOpen: Boolean(selectedItem),
    selectionKey: selectedKey,
    detailsTab,
    showFullDetails,
    isMaximized: isDetailsMaximized,
    historyLength: helmHistory.length,
    historyLoading: helmHistoryLoading,
    logEntryCount,
    eventCount: sortedSelectedEvents.length,
  })

  useEffect(() => {
    if (!showStatusFilter && filters.status) {
      setFilters(prev => ({ ...prev, status: '' }))
    }
  }, [filters.status, showStatusFilter])

  return (
    <Box ref={mainRef} component="main" tabIndex={-1} className={selectedItem ? 'has-details' : undefined} sx={{ p: 2, pb: selectedItem ? `${detailsOffset + 16}px` : 2 }}>
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
        selectedKey={selectedKey}
        detailsOffset={detailsOffset}
        hasSelectedItem={Boolean(selectedItem)}
        sort={sort}
        objectKey={objectKey}
        nextSort={nextSort}
        onSortChange={setSort}
        onSelectKey={setSelectedKey}
        onSelectionChanged={resetDetailsView}
      />
      <DetailsDrawer
        selection={{
          item: selectedItem,
          key: selectedKey,
          resource,
          detailsItem,
          panelRef: detailsPanelRef,
          onClose: closeDetailsAndRestoreFocus,
        }}
        view={{
          isMaximized: isDetailsMaximized,
          onToggleMaximized: () => setIsDetailsMaximized(prev => !prev),
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
          columns: resourceRegistry.events.columns,
          items: sortedSelectedEvents,
          loading: eventsLoading,
          error: eventsError,
          objectKey,
        }}
        history={{
          items: helmHistory,
          loading: helmHistoryLoading,
          error: helmHistoryError,
        }}
        logs={{
          detailsRef: logDetailsRef,
          isMaximized: isDetailsMaximized,
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
          formatLogTimestamp,
          logEntryKey,
        }}
      />
    </Box>
  )
}
