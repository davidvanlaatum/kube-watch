import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { Tooltip } from '@mui/material'
import { useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import type { Column, SortDirection, SortState, TableFilters, ContextInfo, LogEntry } from './types'

export const resourceOptions = [
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
  'events',
  'helmreleases',
]

export const defaultResource = 'pods'

export const eventSupportedResources = new Set([
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

export const logSupportedResources = new Set(['pods', 'deployments'])

const statusFilterResources = new Set(['pods', 'deployments', 'statefulsets', 'jobs', 'events', 'helmreleases'])

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
  helmreleases: 'HelmRelease',
}

export const emptyFilters: TableFilters = {
  name: '',
  status: '',
  labels: '',
  podRestartsOnly: false,
  notReadyOnly: false,
}

function column(
  id: string,
  header: string,
  value: Column['value'],
  options: Pick<Column, 'align' | 'sortValue'> = {},
): Column {
  return { id, header, value, ...options }
}

export const columnsByResource: Record<string, Column[]> = {
  pods: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', podReady, { align: 'center', sortValue: podReadySortValue }),
    column('status', 'STATUS', podStatus, { sortValue: podStatus }),
    column('restarts', 'RESTARTS', podRestarts, { align: 'right', sortValue: podRestartCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
    column('node', 'NODE', (o) => o.spec?.nodeName || '<none>', { sortValue: (o) => o.spec?.nodeName || '' }),
  ],
  deployments: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', (o) => `${o.status?.readyReplicas || 0}/${o.spec?.replicas ?? 0}`, { align: 'center', sortValue: readyReplicasSortValue }),
    column('updated', 'UP-TO-DATE', (o) => o.status?.updatedReplicas || 0, { align: 'right', sortValue: (o) => o.status?.updatedReplicas || 0 }),
    column('available', 'AVAILABLE', (o) => o.status?.availableReplicas || 0, { align: 'right', sortValue: (o) => o.status?.availableReplicas || 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  statefulsets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', (o) => `${o.status?.readyReplicas || 0}/${o.spec?.replicas ?? 0}`, { align: 'center', sortValue: readyReplicasSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  replicasets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('desired', 'DESIRED', (o) => o.spec?.replicas ?? 0, { align: 'right', sortValue: (o) => o.spec?.replicas ?? 0 }),
    column('current', 'CURRENT', (o) => o.status?.replicas ?? 0, { align: 'right', sortValue: (o) => o.status?.replicas ?? 0 }),
    column('ready', 'READY', (o) => o.status?.readyReplicas ?? 0, { align: 'right', sortValue: readyReplicasSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  services: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('type', 'TYPE', (o) => o.spec?.type || '', { sortValue: (o) => o.spec?.type || '' }),
    column('clusterIp', 'CLUSTER-IP', (o) => o.spec?.clusterIP || '<none>', { sortValue: (o) => o.spec?.clusterIP || '' }),
    column('externalIp', 'EXTERNAL-IP', serviceExternalIP, { sortValue: serviceExternalIP }),
    column('ports', 'PORT(S)', servicePorts, { sortValue: servicePorts }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  jobs: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('status', 'STATUS', jobStatus, { sortValue: jobStatus }),
    column('completions', 'COMPLETIONS', (o) => `${o.status?.succeeded || 0}/${o.spec?.completions || 1}`, { align: 'center', sortValue: (o) => o.status?.succeeded || 0 }),
    column('duration', 'DURATION', duration, { align: 'right', sortValue: durationSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  cronjobs: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('schedule', 'SCHEDULE', (o) => o.spec?.schedule || '', { sortValue: (o) => o.spec?.schedule || '' }),
    column('timezone', 'TIMEZONE', (o) => o.spec?.timeZone || '<none>', { sortValue: (o) => o.spec?.timeZone || '' }),
    column('suspend', 'SUSPEND', (o) => String(Boolean(o.spec?.suspend)), { align: 'center', sortValue: (o) => o.spec?.suspend ? 1 : 0 }),
    column('active', 'ACTIVE', (o) => o.status?.active?.length || 0, { align: 'right', sortValue: (o) => o.status?.active?.length || 0 }),
    column('lastSchedule', 'LAST SCHEDULE', lastSchedule, { align: 'right', sortValue: (o) => timestampSortValue(o.status?.lastScheduleTime) }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  hpas: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('reference', 'REFERENCE', hpaReference, { sortValue: hpaReference }),
    column('targets', 'TARGETS', hpaTargets, { sortValue: hpaTargets }),
    column('minPods', 'MINPODS', (o) => o.spec?.minReplicas ?? 1, { align: 'right', sortValue: (o) => o.spec?.minReplicas ?? 1 }),
    column('maxPods', 'MAXPODS', (o) => o.spec?.maxReplicas ?? '', { align: 'right', sortValue: (o) => o.spec?.maxReplicas ?? 0 }),
    column('replicas', 'REPLICAS', (o) => o.status?.currentReplicas ?? 0, { align: 'right', sortValue: (o) => o.status?.currentReplicas ?? 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  configmaps: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('data', 'DATA', (o) => Object.keys(o.data || {}).length, { align: 'right', sortValue: dataKeyCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  secrets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('type', 'TYPE', (o) => o.type || '', { sortValue: (o) => o.type || '' }),
    column('data', 'DATA', (o) => Object.keys(o.data || {}).length, { align: 'right', sortValue: dataKeyCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  serviceaccounts: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('secrets', 'SECRETS', (o) => o.secrets?.length || 0, { align: 'right', sortValue: (o) => o.secrets?.length || 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  poddisruptionbudgets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('minAvailable', 'MIN AVAILABLE', (o) => o.spec?.minAvailable ?? 'N/A', { align: 'right', sortValue: (o) => String(o.spec?.minAvailable ?? '') }),
    column('maxUnavailable', 'MAX UNAVAILABLE', (o) => o.spec?.maxUnavailable ?? 'N/A', { align: 'right', sortValue: (o) => String(o.spec?.maxUnavailable ?? '') }),
    column('allowedDisruptions', 'ALLOWED DISRUPTIONS', (o) => o.status?.disruptionsAllowed ?? 0, { align: 'right', sortValue: (o) => o.status?.disruptionsAllowed ?? 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  networkpolicies: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('podSelector', 'POD-SELECTOR', (o) => labelSelector(o.spec?.podSelector), { sortValue: (o) => labelSelector(o.spec?.podSelector) }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  events: [
    column('lastSeen', 'LAST SEEN', eventLastSeen, { align: 'right', sortValue: eventTimestamp }),
    column('type', 'TYPE', (o) => o.type || '', { sortValue: (o) => o.type || '' }),
    column('reason', 'REASON', (o) => o.reason || '', { sortValue: (o) => o.reason || '' }),
    column('object', 'OBJECT', eventObject, { sortValue: eventObject }),
    column('message', 'MESSAGE', (o) => o.message || '', { sortValue: (o) => o.message || '' }),
  ],
  helmreleases: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('namespace', 'NAMESPACE', (o) => o.metadata?.namespace || '', { sortValue: (o) => o.metadata?.namespace || '' }),
    column('status', 'STATUS', helmStatus, { sortValue: helmStatus }),
    column('chart', 'CHART', (o) => [o.spec?.chart, o.spec?.version].filter(Boolean).join('-'), { sortValue: (o) => [o.spec?.chart, o.spec?.version].filter(Boolean).join('-') }),
    column('appVersion', 'APP VERSION', (o) => o.spec?.appVersion || '', { sortValue: (o) => o.spec?.appVersion || '' }),
    column('revision', 'REVISION', (o) => o.status?.revision ?? 0, { align: 'right', sortValue: (o) => o.status?.revision ?? 0 }),
    column('updated', 'UPDATED', helmUpdated, { align: 'right', sortValue: (o) => timestampSortValue(o.status?.updated) }),
  ],
}

function name(o: any) {
  const resourceName = o.metadata?.name || ''
  return <NameCell name={resourceName} />
}

function NameCell({ name }: { name: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyName = (event: SyntheticEvent) => {
    event.stopPropagation()
    void navigator.clipboard.writeText(name).then(() => {
      setCopyStatus('copied')
      window.setTimeout(() => setCopyStatus('idle'), 1200)
    }).catch((error) => {
      console.warn(error)
      setCopyStatus('failed')
      window.setTimeout(() => setCopyStatus('idle'), 1200)
    })
  }
  const feedback = copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : ''

  return (
    <span className="name-cell">
      <span>{name}</span>
      {name && (
        <>
          <button
            type="button"
            className="copy-name"
            title={feedback || 'Copy resource name'}
            aria-label={feedback ? `${feedback} ${name}` : `Copy ${name}`}
            onClick={copyName}
          >
            <ContentCopyIcon fontSize="small" />
          </button>
          <span className="copy-feedback" aria-live="polite">{feedback}</span>
        </>
      )}
    </span>
  )
}

function age(o: any, now: number) {
  return formatDurationSince(o.metadata?.creationTimestamp, now)
}

function duration(o: any) {
  const start = o.status?.startTime
  const end = o.status?.completionTime
  return start && end ? formatDurationBetween(start, end) : '<none>'
}

function lastSchedule(o: any, now: number) {
  return o.status?.lastScheduleTime ? formatDurationSince(o.status.lastScheduleTime, now) : '<none>'
}

function eventLastSeen(o: any, now: number) {
  return formatDurationSince(o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp, now)
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

function resourceStatus(resource: string, object: any) {
  if (resource === 'pods') return podStatus(object)
  if (resource === 'jobs') return jobStatus(object)
  if (resource === 'events') return object.type || ''
  if (resource === 'helmreleases') return helmStatus(object)
  if (resource === 'deployments' || resource === 'statefulsets') {
    return isReady(resource, object) ? 'Ready' : 'NotReady'
  }
  return object.status?.phase || object.status?.reason || ''
}

function isReady(resource: string, object: any) {
  if (resource === 'pods') {
    const statuses = object.status?.containerStatuses || []
    const total = statuses.length || (object.spec?.containers?.length ?? 0)
    return total > 0 && statuses.filter((s: any) => s.ready).length === total
  }
  if (resource === 'deployments' || resource === 'statefulsets') {
    const desired = object.spec?.replicas ?? 0
    const ready = object.status?.readyReplicas ?? 0
    return ready >= desired
  }
  return true
}

function podRestarts(o: any, now: number) {
  const restarts = podRestartCount(o)
  if (restarts === 0) return 0

  const lastRestartTime = podStatuses(o)
    .map((status: any) => status.lastState?.terminated?.finishedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!lastRestartTime) return restarts

  const restartAge = relativeDurationSince(lastRestartTime, now)
  if (!restartAge) return restarts
  return <TimestampTooltip timestamp={lastRestartTime}>{restarts} ({restartAge} ago)</TimestampTooltip>
}

function podStatuses(o: any) {
  return [
    ...(o.status?.initContainerStatuses || []),
    ...(o.status?.containerStatuses || []),
    ...(o.status?.ephemeralContainerStatuses || []),
  ]
}

function podRestartCount(o: any) {
  return podStatuses(o).reduce((sum: number, status: any) => sum + (status.restartCount || 0), 0)
}

function labelsMatch(object: any, selector: string) {
  const terms = selector.split(',').map(term => term.trim()).filter(Boolean)
  if (terms.length === 0) return true
  const labels = object.metadata?.labels || {}
  return terms.every(term => {
    const [key, value] = parseLabelFilterTerm(term)
    if (!key) return true
    if (value === undefined || value === '') return key in labels
    return String(labels[key] ?? '') === value
  })
}

function parseLabelFilterTerm(term: string): [string, string | undefined] {
  const equalsIndex = term.indexOf('=')
  if (equalsIndex >= 0) {
    return [term.slice(0, equalsIndex).trim(), term.slice(equalsIndex + 1).trim()]
  }
  const colonIndex = term.indexOf(':')
  if (colonIndex >= 0) {
    return [term.slice(0, colonIndex).trim(), term.slice(colonIndex + 1).trim()]
  }
  return [term.trim(), undefined]
}

export function labelSuggestions(objects: any[]) {
  const suggestions = new Set<string>()
  for (const object of objects) {
    const labels = object.metadata?.labels || {}
    for (const [key, value] of Object.entries(labels)) {
      suggestions.add(key)
      suggestions.add(`${key}=${value}`)
      suggestions.add(`${key}: ${value}`)
    }
  }
  return [...suggestions].sort().slice(0, 300)
}

export function contextSelectOptions(contexts: ContextInfo[], selectedContext: string) {
  if (!selectedContext || contexts.some(context => context.name === selectedContext)) return contexts
  return [{ name: selectedContext, namespace: 'loading...' }, ...contexts]
}

export function statusSuggestions(resource: string, objects: any[]) {
  const common: Record<string, string[]> = {
    pods: ['Running', 'Pending', 'Succeeded', 'Failed', 'Unknown', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'ContainerCreating'],
    deployments: ['Ready', 'NotReady'],
    statefulsets: ['Ready', 'NotReady'],
    jobs: ['Running', 'Complete', 'Failed'],
    events: ['Normal', 'Warning'],
    helmreleases: ['deployed', 'failed', 'pending-install', 'pending-upgrade', 'pending-rollback', 'uninstalled', 'uninstalling', 'superseded'],
  }
  const suggestions = new Set(common[resource] || [])
  for (const object of objects) {
    const status = resourceStatus(resource, object)
    if (status) suggestions.add(status)
  }
  return [...suggestions].sort()
}

export function supportsStatusFilter(resource: string) {
  return statusFilterResources.has(resource)
}

export function matchesFilters(resource: string, object: any, filters: TableFilters) {
  const nameFilter = filters.name.trim().toLowerCase()
  if (nameFilter && !String(object.metadata?.name || '').toLowerCase().includes(nameFilter)) return false

  const statusFilter = filters.status.trim().toLowerCase()
  if (statusFilter && resourceStatus(resource, object).toLowerCase() !== statusFilter) return false

  if (!labelsMatch(object, filters.labels)) return false

  if (filters.podRestartsOnly && resource === 'pods' && podRestartCount(object) === 0) return false
  if (filters.notReadyOnly && (resource === 'pods' || resource === 'deployments' || resource === 'statefulsets') && isReady(resource, object)) return false
  return true
}

export function hasActiveFilters(filters: TableFilters) {
  return Boolean(
    filters.name.trim() ||
    filters.status.trim() ||
    filters.labels.trim() ||
    filters.podRestartsOnly ||
    filters.notReadyOnly,
  )
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

function helmStatus(o: any) {
  return o.status?.status || ''
}

function helmUpdated(o: any, now: number) {
  return formatDurationSince(o.status?.updated, now)
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

export function formatDurationSince(timestamp: string | undefined, now = Date.now()) {
  const duration = relativeDurationSince(timestamp, now)
  if (!duration) return ''
  return <TimestampTooltip timestamp={timestamp}>{duration}</TimestampTooltip>
}

function TimestampTooltip({ timestamp, children }: { timestamp: string | undefined; children: ReactNode }) {
  const localTime = formatLocalTimestamp(timestamp)
  return (
    <Tooltip title={localTime || ''}>
      <span>{children}</span>
    </Tooltip>
  )
}

function relativeDurationSince(timestamp: string | undefined, now = Date.now()) {
  if (!timestamp) return ''
  const timestampMillis = new Date(timestamp).getTime()
  if (!Number.isFinite(timestampMillis)) return ''
  return formatMillis(Math.max(0, now - timestampMillis))
}

function formatLocalTimestamp(timestamp: string | undefined) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
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

export function objectKey(object: any) {
  const md = object.metadata || {}
  return md.uid || `${md.name}/${md.namespace || ''}`
}

export function cleanKubernetesObject(object: any) {
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

export function logContainerNames(object: any, resource: string, entries: LogEntry[]) {
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

export function logEntryKey(entry: LogEntry) {
  return `${entry.timestamp}\u0000${entry.pod}\u0000${entry.container}\u0000${entry.seq}\u0000${entry.line}`
}

export function formatLogTimestamp(timestamp: string) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function versionLabel(version: string) {
  if (!version || version === 'dev') return 'dev'
  return version.startsWith('v') ? version : `v${version}`
}

export function supportedResource(resource: string | undefined): resource is string {
  return Boolean(resource && columnsByResource[resource])
}

export function sortItems(resource: string, values: any[], sort: SortState) {
  if (sort) {
    const sortValue = columnsByResource[resource]?.find(column => column.id === sort.columnId)?.sortValue ?? nameSortValue
    return values.sort((a, b) => compareSortValues(
      sortValue(a),
      sortValue(b),
      sort.direction,
    ))
  }
  if (resource === 'events') {
    return values.sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
  }
  return values.sort((a, b) => (a.metadata?.name || '').localeCompare(b.metadata?.name || ''))
}

export function nextSort(current: SortState, columnId: string): SortState {
  if (current?.columnId !== columnId) return { columnId, direction: 'asc' }
  if (current.direction === 'asc') return { columnId, direction: 'desc' }
  return null
}

function compareSortValues(a: string | number, b: string | number, direction: SortDirection) {
  const result = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  return direction === 'asc' ? result : -result
}

function nameSortValue(object: any) {
  return object.metadata?.name || ''
}

function creationTimestampSortValue(object: any) {
  return timestampSortValue(object.metadata?.creationTimestamp)
}

function podReadySortValue(object: any) {
  const statuses = object.status?.containerStatuses || []
  return statuses.filter((status: any) => status.ready).length
}

function readyReplicasSortValue(object: any) {
  return object.status?.readyReplicas ?? 0
}

function dataKeyCount(object: any) {
  return Object.keys(object.data || {}).length
}

function timestampSortValue(timestamp: string | undefined) {
  if (!timestamp) return 0
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : 0
}

function durationSortValue(object: any) {
  const start = timestampSortValue(object.status?.startTime)
  const end = timestampSortValue(object.status?.completionTime)
  return start && end ? end - start : 0
}

function eventTimestamp(o: any) {
  const timestamp = o.lastTimestamp || o.eventTime || o.metadata?.creationTimestamp
  return timestamp ? new Date(timestamp).getTime() : 0
}

export function eventMatchesResource(event: any, resourceObject: any, resource: string) {
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
