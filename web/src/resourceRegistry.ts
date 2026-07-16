import { resourceColumns } from './resourceColumns'
import type { Column } from './types'

export type ResourceDefinition = {
  kind?: string
  columns: Column[]
  supports: {
    events: boolean
    logs: boolean
    history: boolean
    statusFilter: boolean
  }
}

export const resourceRegistry = {
  pods: {
    kind: 'Pod',
    columns: resourceColumns.pods,
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  deployments: {
    kind: 'Deployment',
    columns: resourceColumns.deployments,
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  statefulsets: {
    kind: 'StatefulSet',
    columns: resourceColumns.statefulsets,
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  replicasets: {
    kind: 'ReplicaSet',
    columns: resourceColumns.replicasets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  services: {
    kind: 'Service',
    columns: resourceColumns.services,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  jobs: {
    kind: 'Job',
    columns: resourceColumns.jobs,
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  cronjobs: {
    kind: 'CronJob',
    columns: resourceColumns.cronjobs,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  hpas: {
    kind: 'HorizontalPodAutoscaler',
    columns: resourceColumns.hpas,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  configmaps: {
    kind: 'ConfigMap',
    columns: resourceColumns.configmaps,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  secrets: {
    kind: 'Secret',
    columns: resourceColumns.secrets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  serviceaccounts: {
    kind: 'ServiceAccount',
    columns: resourceColumns.serviceaccounts,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  poddisruptionbudgets: {
    kind: 'PodDisruptionBudget',
    columns: resourceColumns.poddisruptionbudgets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  networkpolicies: {
    kind: 'NetworkPolicy',
    columns: resourceColumns.networkpolicies,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  events: {
    columns: resourceColumns.events,
    supports: { events: false, logs: false, history: false, statusFilter: true },
  },
  helmreleases: {
    kind: 'HelmRelease',
    columns: resourceColumns.helmreleases,
    supports: { events: false, logs: false, history: true, statusFilter: true },
  },
} satisfies Record<string, ResourceDefinition>

export type ResourceName = keyof typeof resourceRegistry

export const resourceOptions = Object.keys(resourceRegistry) as ResourceName[]
export const defaultResource: ResourceName = 'pods'

export function resourceDefinition(resource: string): ResourceDefinition | undefined {
  return resourceRegistry[resource as ResourceName]
}

export function supportedResource(resource: string | undefined): resource is string {
  return Boolean(resource && resourceDefinition(resource))
}
