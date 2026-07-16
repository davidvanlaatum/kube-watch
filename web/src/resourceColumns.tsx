import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { useState } from 'react'
import type { SyntheticEvent } from 'react'
import { RelativeAge, formatDurationBetween } from './components/RelativeAge'
import type { Column } from './types'

function column(
  id: string,
  header: string,
  value: Column['value'],
  options: Pick<Column, 'align' | 'sortValue'> = {},
): Column {
  return { id, header, value, ...options }
}

export const resourceColumns: Record<string, Column[]> = {
  pods: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', podReady, { align: 'center', sortValue: podReadySortValue }),
    column('status', 'STATUS', podStatus, { sortValue: podStatus }),
    column('restarts', 'RESTARTS', podRestarts, { align: 'right', sortValue: podRestartCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
    column('node', 'NODE', object => object.spec?.nodeName || '<none>', { sortValue: object => object.spec?.nodeName || '' }),
  ],
  deployments: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', object => `${object.status?.readyReplicas || 0}/${object.spec?.replicas ?? 0}`, { align: 'center', sortValue: readyReplicasSortValue }),
    column('updated', 'UP-TO-DATE', object => object.status?.updatedReplicas || 0, { align: 'right', sortValue: object => object.status?.updatedReplicas || 0 }),
    column('available', 'AVAILABLE', object => object.status?.availableReplicas || 0, { align: 'right', sortValue: object => object.status?.availableReplicas || 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  statefulsets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('ready', 'READY', object => `${object.status?.readyReplicas || 0}/${object.spec?.replicas ?? 0}`, { align: 'center', sortValue: readyReplicasSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  replicasets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('desired', 'DESIRED', object => object.spec?.replicas ?? 0, { align: 'right', sortValue: object => object.spec?.replicas ?? 0 }),
    column('current', 'CURRENT', object => object.status?.replicas ?? 0, { align: 'right', sortValue: object => object.status?.replicas ?? 0 }),
    column('ready', 'READY', object => object.status?.readyReplicas ?? 0, { align: 'right', sortValue: readyReplicasSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  services: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('type', 'TYPE', object => object.spec?.type || '', { sortValue: object => object.spec?.type || '' }),
    column('clusterIp', 'CLUSTER-IP', object => object.spec?.clusterIP || '<none>', { sortValue: object => object.spec?.clusterIP || '' }),
    column('externalIp', 'EXTERNAL-IP', serviceExternalIP, { sortValue: serviceExternalIP }),
    column('ports', 'PORT(S)', servicePorts, { sortValue: servicePorts }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  jobs: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('status', 'STATUS', jobStatus, { sortValue: jobStatus }),
    column('completions', 'COMPLETIONS', object => `${object.status?.succeeded || 0}/${object.spec?.completions || 1}`, { align: 'center', sortValue: object => object.status?.succeeded || 0 }),
    column('duration', 'DURATION', duration, { align: 'right', sortValue: durationSortValue }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  cronjobs: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('schedule', 'SCHEDULE', object => object.spec?.schedule || '', { sortValue: object => object.spec?.schedule || '' }),
    column('timezone', 'TIMEZONE', object => object.spec?.timeZone || '<none>', { sortValue: object => object.spec?.timeZone || '' }),
    column('suspend', 'SUSPEND', object => String(Boolean(object.spec?.suspend)), { align: 'center', sortValue: object => object.spec?.suspend ? 1 : 0 }),
    column('active', 'ACTIVE', object => object.status?.active?.length || 0, { align: 'right', sortValue: object => object.status?.active?.length || 0 }),
    column('lastSchedule', 'LAST SCHEDULE', lastSchedule, { align: 'right', sortValue: object => timestampSortValue(object.status?.lastScheduleTime) }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  hpas: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('reference', 'REFERENCE', hpaReference, { sortValue: hpaReference }),
    column('targets', 'TARGETS', hpaTargets, { sortValue: hpaTargets }),
    column('minPods', 'MINPODS', object => object.spec?.minReplicas ?? 1, { align: 'right', sortValue: object => object.spec?.minReplicas ?? 1 }),
    column('maxPods', 'MAXPODS', object => object.spec?.maxReplicas ?? '', { align: 'right', sortValue: object => object.spec?.maxReplicas ?? 0 }),
    column('replicas', 'REPLICAS', object => object.status?.currentReplicas ?? 0, { align: 'right', sortValue: object => object.status?.currentReplicas ?? 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  configmaps: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('data', 'DATA', object => Object.keys(object.data || {}).length, { align: 'right', sortValue: dataKeyCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  secrets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('type', 'TYPE', object => object.type || '', { sortValue: object => object.type || '' }),
    column('data', 'DATA', object => Object.keys(object.data || {}).length, { align: 'right', sortValue: dataKeyCount }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  serviceaccounts: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('secrets', 'SECRETS', object => object.secrets?.length || 0, { align: 'right', sortValue: object => object.secrets?.length || 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  poddisruptionbudgets: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('minAvailable', 'MIN AVAILABLE', object => object.spec?.minAvailable ?? 'N/A', { align: 'right', sortValue: object => String(object.spec?.minAvailable ?? '') }),
    column('maxUnavailable', 'MAX UNAVAILABLE', object => object.spec?.maxUnavailable ?? 'N/A', { align: 'right', sortValue: object => String(object.spec?.maxUnavailable ?? '') }),
    column('allowedDisruptions', 'ALLOWED DISRUPTIONS', object => object.status?.disruptionsAllowed ?? 0, { align: 'right', sortValue: object => object.status?.disruptionsAllowed ?? 0 }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  networkpolicies: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('podSelector', 'POD-SELECTOR', object => labelSelector(object.spec?.podSelector), { sortValue: object => labelSelector(object.spec?.podSelector) }),
    column('age', 'AGE', age, { align: 'right', sortValue: creationTimestampSortValue }),
  ],
  events: [
    column('lastSeen', 'LAST SEEN', eventLastSeen, { align: 'right', sortValue: eventTimestamp }),
    column('type', 'TYPE', object => object.type || '', { sortValue: object => object.type || '' }),
    column('reason', 'REASON', object => object.reason || '', { sortValue: object => object.reason || '' }),
    column('object', 'OBJECT', eventObject, { sortValue: eventObject }),
    column('message', 'MESSAGE', object => object.message || '', { sortValue: object => object.message || '' }),
  ],
  helmreleases: [
    column('name', 'NAME', name, { sortValue: nameSortValue }),
    column('namespace', 'NAMESPACE', object => object.metadata?.namespace || '', { sortValue: object => object.metadata?.namespace || '' }),
    column('status', 'STATUS', helmStatus, { sortValue: helmStatus }),
    column('chart', 'CHART', object => [object.spec?.chart, object.spec?.version].filter(Boolean).join('-'), { sortValue: object => [object.spec?.chart, object.spec?.version].filter(Boolean).join('-') }),
    column('appVersion', 'APP VERSION', object => object.spec?.appVersion || '', { sortValue: object => object.spec?.appVersion || '' }),
    column('revision', 'REVISION', object => object.status?.revision ?? 0, { align: 'right', sortValue: object => object.status?.revision ?? 0 }),
    column('updated', 'UPDATED', helmUpdated, { align: 'right', sortValue: object => timestampSortValue(object.status?.updated) }),
  ],
}

function name(object: any) {
  return <NameCell name={object.metadata?.name || ''} />
}

function NameCell({ name }: { name: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyName = (event: SyntheticEvent) => {
    event.stopPropagation()
    void navigator.clipboard.writeText(name).then(() => {
      setCopyStatus('copied')
      window.setTimeout(() => setCopyStatus('idle'), 1200)
    }).catch(error => {
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

function age(object: any) {
  return <RelativeAge timestamp={object.metadata?.creationTimestamp} />
}

function duration(object: any) {
  const start = object.status?.startTime
  const end = object.status?.completionTime
  return start && end ? formatDurationBetween(start, end) : '<none>'
}

function lastSchedule(object: any) {
  return <RelativeAge timestamp={object.status?.lastScheduleTime} fallback="<none>" />
}

function eventLastSeen(object: any) {
  return <RelativeAge timestamp={object.lastTimestamp || object.eventTime || object.metadata?.creationTimestamp} />
}

function eventObject(object: any) {
  const involved = object.involvedObject || {}
  return [involved.kind, involved.name].filter(Boolean).join('/') || '<none>'
}

function podReady(object: any) {
  const statuses = object.status?.containerStatuses || []
  const ready = statuses.filter((status: any) => status.ready).length
  const total = statuses.length || (object.spec?.containers?.length ?? 0)
  return `${ready}/${total}`
}

function podStatus(object: any) {
  const statuses = object.status?.containerStatuses || []
  const waiting = statuses.find((status: any) => status.state?.waiting)?.state?.waiting?.reason
  const terminated = statuses.find((status: any) => status.state?.terminated)?.state?.terminated?.reason
  return waiting || terminated || object.status?.phase || ''
}

export function resourceStatus(resource: string, object: any) {
  if (resource === 'pods') return podStatus(object)
  if (resource === 'jobs') return jobStatus(object)
  if (resource === 'events') return object.type || ''
  if (resource === 'helmreleases') return helmStatus(object)
  if (resource === 'deployments' || resource === 'statefulsets') return isReady(resource, object) ? 'Ready' : 'NotReady'
  return object.status?.phase || object.status?.reason || ''
}

export function isReady(resource: string, object: any) {
  if (resource === 'pods') {
    const statuses = object.status?.containerStatuses || []
    const total = statuses.length || (object.spec?.containers?.length ?? 0)
    return total > 0 && statuses.filter((status: any) => status.ready).length === total
  }
  if (resource === 'deployments' || resource === 'statefulsets') {
    return (object.status?.readyReplicas ?? 0) >= (object.spec?.replicas ?? 0)
  }
  return true
}

function podRestarts(object: any) {
  const restarts = podRestartCount(object)
  if (restarts === 0) return 0

  const lastRestartTime = podStatuses(object)
    .map((status: any) => status.lastState?.terminated?.finishedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!lastRestartTime) return restarts

  return <RelativeAge timestamp={lastRestartTime} fallback={restarts}>{restartAge => `${restarts} (${restartAge} ago)`}</RelativeAge>
}

function podStatuses(object: any) {
  return [
    ...(object.status?.initContainerStatuses || []),
    ...(object.status?.containerStatuses || []),
    ...(object.status?.ephemeralContainerStatuses || []),
  ]
}

export function podRestartCount(object: any) {
  return podStatuses(object).reduce((sum: number, status: any) => sum + (status.restartCount || 0), 0)
}

function serviceExternalIP(object: any) {
  const ingress = object.status?.loadBalancer?.ingress || []
  const addresses = ingress.map((item: any) => item.ip || item.hostname).filter(Boolean)
  return addresses.length ? addresses.join(',') : '<none>'
}

function servicePorts(object: any) {
  return (object.spec?.ports || [])
    .map((port: any) => `${port.port}${port.nodePort ? `:${port.nodePort}` : ''}/${port.protocol || 'TCP'}`)
    .join(',')
}

function jobStatus(object: any) {
  if (object.status?.succeeded) return 'Complete'
  if (object.status?.failed) return 'Failed'
  if (object.status?.active) return 'Running'
  return ''
}

function helmStatus(object: any) {
  return object.status?.status || ''
}

function helmUpdated(object: any) {
  return <RelativeAge timestamp={object.status?.updated} />
}

function hpaReference(object: any) {
  const reference = object.spec?.scaleTargetRef
  if (!reference) return '<none>'
  return `${reference.kind || ''}/${reference.name || ''}`
}

function labelSelector(selector?: any) {
  const labels = selector?.matchLabels || {}
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${value}`)
  return parts.length ? parts.join(',') : '<none>'
}

function hpaTargets(object: any) {
  const metrics = object.spec?.metrics || []
  const currentMetrics = object.status?.currentMetrics || []
  if (metrics.length === 0) return '<unknown>'

  return metrics.map((metric: any, index: number) => {
    const current = currentMetrics[index]
    if (metric.type === 'Resource') {
      const resourceName = metric.resource?.name || 'resource'
      return `${metricCurrentValue(current?.resource)}/${metricTargetValue(metric.resource?.target)} ${resourceName}`
    }
    if (metric.type === 'Pods') return `${metricCurrentValue(current?.pods)}/${metricTargetValue(metric.pods?.target)} pods`
    if (metric.type === 'Object') return `${metricCurrentValue(current?.object)}/${metricTargetValue(metric.object?.target)} object`
    if (metric.type === 'External') return `${metricCurrentValue(current?.external)}/${metricTargetValue(metric.external?.target)} external`
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

export function eventTimestamp(object: any) {
  const timestamp = object.lastTimestamp || object.eventTime || object.metadata?.creationTimestamp
  return timestamp ? new Date(timestamp).getTime() : 0
}
