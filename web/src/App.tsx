import React, { useEffect, useState, useRef } from 'react'
import { stringify } from 'yaml'

type ContextInfo = { name: string; namespace: string }
type Envelope = { type?: string; object?: any; error?: string; info?: string }
type DetailsTab = 'yaml' | 'events'
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
  return o.metadata?.name || ''
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
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const eventsEsRef = useRef<EventSource | null>(null)

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
  const sortedSelectedEvents = sortItems('events', [...selectedEvents.values()])

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
