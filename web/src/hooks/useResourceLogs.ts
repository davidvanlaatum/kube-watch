import { useEffect, useMemo, useRef, useState } from 'react'
import { logContainerNames, logEntryKey } from '../resourceUtils'
import type { DetailsTab, LogEntry, LogEnvelope } from '../types'

type ResourceLogsOptions = {
  ctx: string
  resource: string
  selectedItem: any
  supportsLogs: boolean
  detailsTab: DetailsTab
  tailLines: number
  isDetailsMaximized: boolean
}

const LOG_RECONNECT_ERROR = 'Log stream interrupted; waiting for EventSource to reconnect'

export function useResourceLogs({
  ctx,
  resource,
  selectedItem,
  supportsLogs,
  detailsTab,
  tailLines,
  isDetailsMaximized,
}: ResourceLogsOptions) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeContainer, setActiveContainer] = useState<string>('')
  const [autoScroll, setAutoScroll] = useState(true)
  const detailsRef = useRef<HTMLDivElement | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const selectedName = selectedItem?.metadata?.name || ''
  const selectedNamespace = selectedItem?.metadata?.namespace || ''
  const selectedContainerSpecKey = selectedItem ? containerSpecKey(selectedItem, resource) : ''

  const specContainers = useMemo(
    () => selectedItem ? logContainerNames(selectedItem, resource, []) : [],
    [resource, selectedContainerSpecKey],
  )
  const containers = useMemo(() => {
    const names = new Set(specContainers)
    for (const entry of entries) {
      if (entry.container) names.add(entry.container)
    }
    return [...names].sort()
  }, [entries, specContainers])
  const containersKey = containers.join('\u0000')

  const sortedEntries = useMemo(() => {
    return entries
      .filter(entry => entry.container === activeContainer)
      .sort((a, b) => {
        const timeCompare = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        if (timeCompare !== 0) return timeCompare
        if (a.pod !== b.pod) return a.pod.localeCompare(b.pod)
        return a.seq - b.seq
      })
  }, [entries, activeContainer])

  useEffect(() => {
    if (!containers.includes(activeContainer)) {
      setActiveContainer(containers[0] || '')
    }
  }, [activeContainer, containers, containersKey])

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setEntries([])
    setError(null)

    if (!ctx || !selectedName || !selectedNamespace || !supportsLogs || detailsTab !== 'logs') {
      setLoading(false)
      return
    }

    setLoading(true)
    const url = `/logs/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}/${encodeURIComponent(selectedNamespace)}/${encodeURIComponent(selectedName)}?tailLines=${encodeURIComponent(String(tailLines))}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: LogEnvelope = JSON.parse(ev.data)
        if (env.type === 'LOG' && env.pod && env.container && env.line !== undefined) {
          setLoading(false)
          setError(prev => prev === LOG_RECONNECT_ERROR ? null : prev)
          const entry: LogEntry = {
            pod: env.pod,
            container: env.container,
            timestamp: env.timestamp || new Date().toISOString(),
            line: env.line,
            seq: env.seq || 0,
          }
          setEntries(prev => {
            const key = logEntryKey(entry)
            if (prev.some(existing => logEntryKey(existing) === key)) return prev
            return [...prev, entry].slice(-10000)
          })
          return
        }
        if (env.type === 'INFO') {
          setError(prev => prev === LOG_RECONNECT_ERROR ? null : prev)
          return
        }
        if (env.type === 'ERROR' || env.error) {
          setLoading(false)
          setError(env.error || 'Log stream error')
        }
      } catch (parseError) {
        console.warn('log stream parse', parseError)
      }
    }
    es.onerror = (streamError) => {
      setLoading(false)
      setError(prev => prev && prev !== LOG_RECONNECT_ERROR ? prev : LOG_RECONNECT_ERROR)
      console.warn('log stream error', streamError)
    }
    esRef.current = es
    return () => {
      es.close()
      esRef.current = null
    }
  }, [ctx, resource, selectedName, selectedNamespace, selectedContainerSpecKey, supportsLogs, detailsTab, tailLines])

  useEffect(() => {
    if (!autoScroll || !detailsRef.current) return
    detailsRef.current.scrollTop = detailsRef.current.scrollHeight
  }, [autoScroll, sortedEntries, activeContainer, isDetailsMaximized])

  return {
    detailsRef,
    containers,
    activeContainer,
    setActiveContainer,
    autoScroll,
    setAutoScroll,
    loading,
    error,
    sortedEntries,
    entryCount: entries.length,
  }

  function containerSpecKey(object: any, resource: string) {
    const spec = resource === 'deployments' ? object?.spec?.template?.spec : object?.spec
    return [
      selectedContainerNames(spec?.initContainers),
      selectedContainerNames(spec?.containers),
      selectedContainerNames(spec?.ephemeralContainers),
    ].join('|')
  }

  function selectedContainerNames(containers: any[] | undefined) {
    return (containers || []).map(container => container?.name || '').join('\u0000')
  }
}
