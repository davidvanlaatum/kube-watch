import React, { useEffect, useMemo, useState, useRef } from 'react'
import { stringify } from 'yaml'

type ContextInfo = { name: string; namespace: string }
type Envelope = { type?: string; object?: any; error?: string; info?: string }
type LogEnvelope = { type?: string; pod?: string; container?: string; timestamp?: string; line?: string; error?: string; info?: string; seq?: number }
type LogEntry = { pod: string; container: string; timestamp: string; line: string; seq: number }
type DetailsTab = 'yaml' | 'events' | 'logs'
type Column = {
  header: string
  value: (object: any) => React.ReactNode
  align?: 'left' | 'center' | 'right'
}

const eventSupportedResources = new Set([
  'pods',
  'deployments',
  'statefulsets',
  'replicasets',
  'services',
  'jobs',
  'cronjobs',
  'hpas',
  'configmaps',
  'secrets',
  'serviceaccounts',
  'poddisruptionbudgets',
  'networkpolicies',
])
const logSupportedResources = new Set(['pods', 'deployments'])
const resourceKinds: Record<string, string> = {
  pods: 'Pod',
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  replicasets: 'ReplicaSet',
  services: 'Service',
  jobs: 'Job',
  cronjobs: 'CronJob',
  hpas: 'HorizontalPodAutoscaler',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  serviceaccounts: 'ServiceAccount',
  poddisruptionbudgets: 'PodDisruptionBudget',
  networkpolicies: 'NetworkPolicy',
}

const columnsByResource: Record<string, Column[]> = {
  pods: [
    { header: 'NAME', value: name },
    { header: 'READY', value: podReady, align: 'center' },
    { header: 'STATUS', value: podStatus },
    { header: 'RESTARTS', value: podRestarts, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
    { header: 'NODE', value: (o) => o.spec?.nodeName || '<none>' },
  ],
  deployments: [
    { header: 'NAME', value: name },
    { header: 'READY', value: (o) => `${o.status?.readyReplicas || 0}/${o.spec?.replicas ?? 0}`, align: 'center' },
    { header: 'UP-TO-DATE', value: (o) => o.status?.updatedReplicas || 0, align: 'right' },
    { header: 'AVAILABLE', value: (o) => o.status?.availableReplicas || 0, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  statefulsets: [
    { header: 'NAME', value: name },
    { header: 'READY', value: (o) => `${o.status?.readyReplicas || 0}/${o.spec?.replicas ?? 0}`, align: 'center' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  replicasets: [
    { header: 'NAME', value: name },
    { header: 'DESIRED', value: (o) => o.spec?.replicas ?? 0, align: 'right' },
    { header: 'CURRENT', value: (o) => o.status?.replicas ?? 0, align: 'right' },
    { header: 'READY', value: (o) => o.status?.readyReplicas ?? 0, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  services: [
    { header: 'NAME', value: name },
    { header: 'TYPE', value: (o) => o.spec?.type || '' },
    { header: 'CLUSTER-IP', value: (o) => o.spec?.clusterIP || '<none>' },
    { header: 'EXTERNAL-IP', value: serviceExternalIP },
    { header: 'PORT(S)', value: servicePorts },
    { header: 'AGE', value: age, align: 'right' },
  ],
  jobs: [
    { header: 'NAME', value: name },
    { header: 'STATUS', value: jobStatus },
    { header: 'COMPLETIONS', value: (o) => `${o.status?.succeeded || 0}/${o.spec?.completions || 1}`, align: 'center' },
    { header: 'DURATION', value: duration, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  cronjobs: [
    { header: 'NAME', value: name },
    { header: 'SCHEDULE', value: (o) => o.spec?.schedule || '' },
    { header: 'TIMEZONE', value: (o) => o.spec?.timeZone || '<none>' },
    { header: 'SUSPEND', value: (o) => String(Boolean(o.spec?.suspend)), align: 'center' },
    { header: 'ACTIVE', value: (o) => o.status?.active?.length || 0, align: 'right' },
    { header: 'LAST SCHEDULE', value: lastSchedule, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  hpas: [
    { header: 'NAME', value: name },
    { header: 'REFERENCE', value: hpaReference },
    { header: 'TARGETS', value: hpaTargets },
    { header: 'MINPODS', value: (o) => o.spec?.minReplicas ?? 1, align: 'right' },
    { header: 'MAXPODS', value: (o) => o.spec?.maxReplicas ?? '', align: 'right' },
    { header: 'REPLICAS', value: (o) => o.status?.currentReplicas ?? 0, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  configmaps: [
    { header: 'NAME', value: name },
    { header: 'DATA', value: (o) => Object.keys(o.data || {}).length, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  secrets: [
    { header: 'NAME', value: name },
    { header: 'TYPE', value: (o) => o.type || '' },
    { header: 'DATA', value: (o) => Object.keys(o.data || {}).length, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  serviceaccounts: [
    { header: 'NAME', value: name },
    { header: 'SECRETS', value: (o) => o.secrets?.length || 0, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  poddisruptionbudgets: [
    { header: 'NAME', value: name },
    { header: 'MIN AVAILABLE', value: (o) => o.spec?.minAvailable ?? 'N/A', align: 'right' },
    { header: 'MAX UNAVAILABLE', value: (o) => o.spec?.maxUnavailable ?? 'N/A', align: 'right' },
    { header: 'ALLOWED DISRUPTIONS', value: (o) => o.status?.disruptionsAllowed ?? 0, align: 'right' },
    { header: 'AGE', value: age, align: 'right' },
  ],
  networkpolicies: [
    { header: 'NAME', value: name },
    { header: 'POD-SELECTOR', value: (o) => labelSelector(o.spec?.podSelector) },
    { header: 'AGE', value: age, align: 'right' },
  ],
  events: [
    { header: 'LAST SEEN', value: eventLastSeen, align: 'right' },
    { header: 'TYPE', value: (o) => o.type || '' },
    { header: 'REASON', value: (o) => o.reason || '' },
    { header: 'OBJECT', value: eventObject },
    { header: 'MESSAGE', value: (o) => o.message || '' },
  ],
}

function name(o: any) {
  const resourceName = o.metadata?.name || ''
  return <NameCell name={resourceName} />
}

function NameCell({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <span className="name-cell">
      <span>{name}</span>
      {name && (
        <button
          type="button"
          className="copy-name"
          title="Copy resource name"
          aria-label={`Copy ${name}`}
          onClick={(event) => {
            event.stopPropagation()
            void navigator.clipboard.writeText(name).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </span>
  )
}

function age(o: any) {
  return formatDurationSince(o.metadata?.creationTimestamp)
}

function duration(o: any) {
  const start = o.status?.startTime
  const end = o.status?.completionTime
  return start && end ? formatDurationBetween(start, end) : '<none>'
}

function lastSchedule(o: any) {
  return o.status?.lastScheduleTime ? formatDurationSince(o.status.lastScheduleTime) : '<none>'
}

function eventLastSeen(o: any) {
  return formatDurationSince(o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp)
}

function eventObject(o: any) {
  const involved = o.involvedObject || {}
  return [involved.kind, involved.name].filter(Boolean).join('/') || '<none>'
}

function podReady(o: any) {
  const statuses = o.status?.containerStatuses || []
  const ready = statuses.filter((s: any) => s.ready).length
  const total = statuses.length || (o.spec?.containers?.length ?? 0)
  return `${ready}/${total}`
}

function podStatus(o: any) {
  const statuses = o.status?.containerStatuses || []
  const waiting = statuses.find((s: any) => s.state?.waiting)?.state?.waiting?.reason
  const terminated = statuses.find((s: any) => s.state?.terminated)?.state?.terminated?.reason
  return waiting || terminated || o.status?.phase || ''
}

function podRestarts(o: any) {
  const statuses = [
    ...(o.status?.initContainerStatuses || []),
    ...(o.status?.containerStatuses || []),
    ...(o.status?.ephemeralContainerStatuses || []),
  ]
  const restarts = statuses.reduce((sum: number, status: any) => sum + (status.restartCount || 0), 0)
  if (restarts === 0) return 0

  const lastRestartTime = statuses
    .map((status: any) => status.lastState?.terminated?.finishedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!lastRestartTime) return restarts

  return `${restarts} (${formatDurationSince(lastRestartTime)} ago)`
}

function serviceExternalIP(o: any) {
  const ingress = o.status?.loadBalancer?.ingress || []
  const addresses = ingress.map((i: any) => i.ip || i.hostname).filter(Boolean)
  return addresses.length ? addresses.join(',') : '<none>'
}

function servicePorts(o: any) {
  return (o.spec?.ports || [])
    .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol || 'TCP'}`)
    .join(',')
}

function jobStatus(o: any) {
  if (o.status?.succeeded) return 'Complete'
  if (o.status?.failed) return 'Failed'
  if (o.status?.active) return 'Running'
  return ''
}

function hpaReference(o: any) {
  const ref = o.spec?.scaleTargetRef
  if (!ref) return '<none>'
  return `${ref.kind || ''}/${ref.name || ''}`
}

function labelSelector(selector?: any) {
  const labels = selector?.matchLabels || {}
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${value}`)
  return parts.length ? parts.join(',') : '<none>'
}

function hpaTargets(o: any) {
  const metrics = o.spec?.metrics || []
  const currentMetrics = o.status?.currentMetrics || []
  if (metrics.length === 0) return '<unknown>'

  return metrics.map((metric: any, index: number) => {
    const current = currentMetrics[index]
    if (metric.type === 'Resource') {
      const resourceName = metric.resource?.name || 'resource'
      return `${metricCurrentValue(current?.resource)}/${metricTargetValue(metric.resource?.target)} ${resourceName}`
    }
    if (metric.type === 'Pods') {
      return `${metricCurrentValue(current?.pods)}/${metricTargetValue(metric.pods?.target)} pods`
    }
    if (metric.type === 'Object') {
      return `${metricCurrentValue(current?.object)}/${metricTargetValue(metric.object?.target)} object`
    }
    if (metric.type === 'External') {
      return `${metricCurrentValue(current?.external)}/${metricTargetValue(metric.external?.target)} external`
    }
    return `<unknown>/${metric.type || 'unknown'}`
  }).join(', ')
}

function metricCurrentValue(metric?: any) {
  return metric?.current?.averageUtilization ??
    metric?.current?.averageValue ??
    metric?.current?.value ??
    '<unknown>'
}

function metricTargetValue(target?: any) {
  return target?.averageUtilization ??
    target?.averageValue ??
    target?.value ??
    '<unknown>'
}

function formatDurationSince(timestamp?: string) {
  if (!timestamp) return ''
  return formatMillis(Date.now() - new Date(timestamp).getTime())
}

function formatDurationBetween(start: string, end: string) {
  return formatMillis(new Date(end).getTime() - new Date(start).getTime())
}

function formatMillis(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function alignClass(column: Column) {
  return column.align ? `align-${column.align}` : undefined
}

function objectKey(object: any) {
  const md = object.metadata || {}
  return md.uid || `${md.name}/${md.namespace || ''}`
}

function cleanKubernetesObject(object: any) {
  const copy = structuredClone(object)
  if (copy.metadata) {
    delete copy.metadata.managedFields
    delete copy.metadata.resourceVersion
    delete copy.metadata.uid
    delete copy.metadata.selfLink
    if (copy.metadata.annotations) {
      delete copy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']
      delete copy.metadata.annotations['deployment.kubernetes.io/revision']
      if (Object.keys(copy.metadata.annotations).length === 0) {
        delete copy.metadata.annotations
      }
    }
  }
  return copy
}

function logContainerNames(object: any, resource: string, entries: LogEntry[]) {
  const spec = resource === 'deployments' ? object?.spec?.template?.spec : object?.spec
  const names = new Set<string>()
  for (const container of [
    ...(spec?.initContainers || []),
    ...(spec?.containers || []),
    ...(spec?.ephemeralContainers || []),
  ]) {
    if (container?.name) names.add(container.name)
  }
  for (const entry of entries) {
    if (entry.container) names.add(entry.container)
  }
  return [...names].sort()
}

function logEntryKey(entry: LogEntry) {
  return `${entry.timestamp}\u0000${entry.pod}\u0000${entry.container}\u0000${entry.line}`
}

function formatLogTimestamp(timestamp: string) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function App() {
  const [contexts, setContexts] = useState<ContextInfo[]>([])
  const [ctx, setCtx] = useState<string>('')
  const [resource, setResource] = useState<string>('pods')
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('yaml')
  const [showFullDetails, setShowFullDetails] = useState(false)
  const [selectedEvents, setSelectedEvents] = useState<Map<string, any>>(new Map())
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [activeLogContainer, setActiveLogContainer] = useState<string>('')
  const [logTailLines, setLogTailLines] = useState(200)
  const [autoScrollLogs, setAutoScrollLogs] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const eventsEsRef = useRef<EventSource | null>(null)
  const logsEsRef = useRef<EventSource | null>(null)
  const logDetailsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    fetch('/api/contexts').then(r => r.json()).then(setContexts).catch(console.error)
  }, [])

  useEffect(() => {
    if (!ctx) return
    // close existing
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setItems(new Map())
    setSelectedKey(null)
    setDetailsTab('yaml')
    setShowFullDetails(false)
    setLogEntries([])
    setLogsError(null)
    setActiveLogContainer('')
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
  const sortedItems = sortItems(resource, [...items.values()])
  const selectedItem = selectedKey ? items.get(selectedKey) : null
  const detailsItem = selectedItem && (showFullDetails ? selectedItem : cleanKubernetesObject(selectedItem))
  const supportsEvents = Boolean(selectedItem && eventSupportedResources.has(resource))
  const supportsLogs = Boolean(selectedItem && logSupportedResources.has(resource))
  const sortedSelectedEvents = sortItems('events', [...selectedEvents.values()])
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
    <div className="app">
      <header>
        <h1>kube-watch</h1>
        <div className="controls">
          <select value={ctx} onChange={e=>setCtx(e.target.value)}>
            <option value="">Select context</option>
            {contexts.map(c=> <option key={c.name} value={c.name}>{c.name} ({c.namespace})</option>)}
          </select>
          <select value={resource} onChange={e=>setResource(e.target.value)}>
            <option value="pods">pods</option>
            <option value="deployments">deployments</option>
            <option value="statefulsets">statefulsets</option>
            <option value="replicasets">replicasets</option>
            <option value="services">services</option>
            <option value="jobs">jobs</option>
            <option value="cronjobs">cronjobs</option>
            <option value="hpas">hpas</option>
            <option value="configmaps">configmaps</option>
            <option value="secrets">secrets</option>
            <option value="serviceaccounts">serviceaccounts</option>
            <option value="poddisruptionbudgets">poddisruptionbudgets</option>
            <option value="networkpolicies">networkpolicies</option>
            <option value="events">events</option>
          </select>
        </div>
      </header>
      <main className={selectedItem ? 'has-details' : undefined}>
        {isLoading && (
          <div className="loading-banner" role="status">
            <span className="spinner" aria-hidden="true" />
            Loading {resource}...
          </div>
        )}
        {loadError && !isLoading && <div className="error-banner">{loadError}</div>}
        <section className="resource-table">
          <table>
            <thead>
              <tr>
                {columns.map(column => <th key={column.header} className={alignClass(column)}>{column.header}</th>)}
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((o:any) => {
                const key = objectKey(o)
                return (
                  <tr
                    key={key}
                    className={selectedKey === key ? 'selected' : undefined}
                    onClick={() => setSelectedKey(prev => {
                      const next = prev === key ? null : key
                      if (next !== prev) {
                        setShowFullDetails(false)
                        setDetailsTab('yaml')
                        setLogEntries([])
                        setLogsError(null)
                        setActiveLogContainer('')
                      }
                      return next
                    })}
                  >
                    {columns.map(column => <td key={column.header} className={alignClass(column)}>{column.value(o)}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
        {selectedItem && (
          <section className="details-panel" aria-label="Selected resource details">
            <div className="details-header">
              <h2>{selectedItem.kind || resource}/{selectedItem.metadata?.name || selectedKey}</h2>
              <div className="details-actions">
                {detailsTab === 'yaml' && (
                  <button type="button" onClick={() => setShowFullDetails(prev => !prev)}>
                    {showFullDetails ? 'Hide housekeeping' : 'Show full YAML'}
                  </button>
                )}
                <button type="button" onClick={() => {
                  setSelectedKey(null)
                  setShowFullDetails(false)
                  setDetailsTab('yaml')
                }}>Close</button>
              </div>
            </div>
            <div className="details-tabs" role="tablist">
              <button
                type="button"
                className={detailsTab === 'yaml' ? 'active' : undefined}
                onClick={() => setDetailsTab('yaml')}
              >
                YAML
              </button>
              {supportsEvents && (
                <button
                  type="button"
                  className={detailsTab === 'events' ? 'active' : undefined}
                  onClick={() => setDetailsTab('events')}
                >
                  Events
                </button>
              )}
              {supportsLogs && (
                <button
                  type="button"
                  className={detailsTab === 'logs' ? 'active' : undefined}
                  onClick={() => setDetailsTab('logs')}
                >
                  Logs
                </button>
              )}
            </div>
            {detailsTab === 'yaml' && <pre>{stringify(detailsItem)}</pre>}
            {detailsTab === 'events' && supportsEvents && (
              <div className="event-details">
                {eventsLoading && (
                  <div className="inline-status">
                    <span className="spinner" aria-hidden="true" />
                    Loading events...
                  </div>
                )}
                {eventsError && <div className="inline-error">{eventsError}</div>}
                {!eventsLoading && sortedSelectedEvents.length === 0 && !eventsError && (
                  <div className="empty-state">No events found for this resource.</div>
                )}
                {sortedSelectedEvents.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        {columnsByResource.events.map(column => (
                          <th key={column.header} className={alignClass(column)}>{column.header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSelectedEvents.map((event: any) => (
                        <tr key={objectKey(event)}>
                          {columnsByResource.events.map(column => (
                            <td key={column.header} className={alignClass(column)}>{column.value(event)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {detailsTab === 'logs' && supportsLogs && (
              <div ref={logDetailsRef} className="log-details">
                <div className="log-controls">
                  <div className="log-options">
                    <label>
                      Tail lines
                      <input
                        type="number"
                        min="0"
                        max="5000"
                        value={logTailLines}
                        onChange={(event) => {
                          const next = Number.parseInt(event.target.value, 10)
                          if (Number.isFinite(next)) {
                            setLogTailLines(Math.max(0, Math.min(5000, next)))
                          }
                        }}
                      />
                    </label>
                    <span>Live follow</span>
                    <button type="button" onClick={() => setAutoScrollLogs(prev => !prev)}>
                      Auto scroll {autoScrollLogs ? 'on' : 'off'}
                    </button>
                  </div>
                  {logContainers.length > 0 && (
                    <div className="container-tabs" role="tablist" aria-label="Log containers">
                      {logContainers.map(container => (
                        <button
                          key={container}
                          type="button"
                          className={activeLogContainer === container ? 'active' : undefined}
                          onClick={() => setActiveLogContainer(container)}
                        >
                          {container}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {logsLoading && (
                  <div className="inline-status">
                    <span className="spinner" aria-hidden="true" />
                    Loading logs...
                  </div>
                )}
                {logsError && <div className="inline-error">{logsError}</div>}
                {!logsLoading && !logsError && logContainers.length === 0 && (
                  <div className="empty-state">No containers found for this {resource === 'pods' ? 'pod' : 'deployment'}.</div>
                )}
                {!logsLoading && !logsError && logContainers.length > 0 && sortedLogEntries.length === 0 && (
                  <div className="empty-state">Waiting for log lines for container {activeLogContainer}...</div>
                )}
                {sortedLogEntries.length > 0 && (
                  <div className="log-output" aria-label={`Logs for ${activeLogContainer}`}>
                    {sortedLogEntries.map(entry => (
                      <div key={logEntryKey(entry)} className="log-line">
                        <span className="log-time">{formatLogTimestamp(entry.timestamp)} </span>
                        <span className="log-pod">{entry.pod}: </span>
                        <span className="log-message">{entry.line}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}

function sortItems(resource: string, values: any[]) {
  if (resource === 'events') {
    return values.sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
  }
  return values.sort((a, b) => (a.metadata?.name || '').localeCompare(b.metadata?.name || ''))
}

function eventTimestamp(o: any) {
  const timestamp = o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp
  return timestamp ? new Date(timestamp).getTime() : 0
}

function eventMatchesResource(event: any, resourceObject: any, resource: string) {
  const involved = event.involvedObject || {}
  const md = resourceObject.metadata || {}
  if (involved.uid && md.uid) {
    return involved.uid === md.uid
  }
  const expectedKind = resourceObject.kind || resourceKinds[resource]
  return involved.name === md.name &&
    involved.namespace === md.namespace &&
    (!expectedKind || !involved.kind || involved.kind === expectedKind)
}
