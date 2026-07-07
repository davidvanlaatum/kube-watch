import React, { useEffect, useState, useRef } from 'react'
import { stringify } from 'yaml'

type ContextInfo = { name: string; namespace: string }
type Envelope = { type?: string; object?: any; error?: string; info?: string }
type Column = {
  header: string
  value: (object: any) => React.ReactNode
  align?: 'left' | 'center' | 'right'
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
  return (o.status?.containerStatuses || []).reduce((sum: number, status: any) => sum + (status.restartCount || 0), 0)
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

export default function App() {
  const [contexts, setContexts] = useState<ContextInfo[]>([])
  const [ctx, setCtx] = useState<string>('')
  const [resource, setResource] = useState<string>('pods')
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

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
    setIsLoading(true)
    setLoadError(null)
    const url = `/sse/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        } else if (env.type === 'DELETED') {
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
          setSelectedKey(prev => prev === uid ? null : prev)
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
  const sortedItems = [...items.values()].sort((a: any, b: any) =>
    (a.metadata?.name || '').localeCompare(b.metadata?.name || '')
  )
  const selectedItem = selectedKey ? items.get(selectedKey) : null

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
            <option value="services">services</option>
            <option value="jobs">jobs</option>
            <option value="cronjobs">cronjobs</option>
            <option value="configmaps">configmaps</option>
            <option value="secrets">secrets</option>
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
                    onClick={() => setSelectedKey(prev => prev === key ? null : key)}
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
              <button type="button" onClick={() => setSelectedKey(null)}>Close</button>
            </div>
            <pre>{stringify(selectedItem)}</pre>
          </section>
        )}
      </main>
    </div>
  )
}
