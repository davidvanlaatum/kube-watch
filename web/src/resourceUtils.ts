import { resourceDefinition } from './resourceRegistry'
import type { LogEntry } from './types'

export function objectKey(object: any) {
  const metadata = object.metadata || {}
  return metadata.uid || `${metadata.name}/${metadata.namespace || ''}`
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
      if (Object.keys(copy.metadata.annotations).length === 0) delete copy.metadata.annotations
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

export function eventMatchesResource(event: any, resourceObject: any, resource: string) {
  const involved = event.involvedObject || {}
  const metadata = resourceObject.metadata || {}
  if (involved.uid && metadata.uid) return involved.uid === metadata.uid

  const expectedKind = resourceObject.kind || resourceDefinition(resource)?.kind
  return involved.name === metadata.name &&
    involved.namespace === metadata.namespace &&
    (!expectedKind || !involved.kind || involved.kind === expectedKind)
}
