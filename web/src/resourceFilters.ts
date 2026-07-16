import { isReady, podRestartCount, resourceStatus } from './resourceColumns'
import type { ContextInfo, TableFilters } from './types'

export const emptyFilters: TableFilters = {
  name: '',
  status: '',
  labels: '',
  podRestartsOnly: false,
  notReadyOnly: false,
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
  if (equalsIndex >= 0) return [term.slice(0, equalsIndex).trim(), term.slice(equalsIndex + 1).trim()]
  const colonIndex = term.indexOf(':')
  if (colonIndex >= 0) return [term.slice(0, colonIndex).trim(), term.slice(colonIndex + 1).trim()]
  return [term.trim(), undefined]
}
