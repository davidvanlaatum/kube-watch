import { resourceColumns } from './resourceColumns'
import type { Column } from './types'

export type ResourceDefinition = {
  label: string
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
    label: 'Pods',
    kind: 'Pod',
    columns: resourceColumns.pods,
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  deployments: {
    label: 'Deployments',
    kind: 'Deployment',
    columns: resourceColumns.deployments,
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  statefulsets: {
    label: 'Stateful Sets',
    kind: 'StatefulSet',
    columns: resourceColumns.statefulsets,
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  replicasets: {
    label: 'Replica Sets',
    kind: 'ReplicaSet',
    columns: resourceColumns.replicasets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  services: {
    label: 'Services',
    kind: 'Service',
    columns: resourceColumns.services,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  jobs: {
    label: 'Jobs',
    kind: 'Job',
    columns: resourceColumns.jobs,
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  cronjobs: {
    label: 'Cron Jobs',
    kind: 'CronJob',
    columns: resourceColumns.cronjobs,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  hpas: {
    label: 'Horizontal Pod Autoscalers',
    kind: 'HorizontalPodAutoscaler',
    columns: resourceColumns.hpas,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  configmaps: {
    label: 'Config Maps',
    kind: 'ConfigMap',
    columns: resourceColumns.configmaps,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  secrets: {
    label: 'Secrets',
    kind: 'Secret',
    columns: resourceColumns.secrets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  serviceaccounts: {
    label: 'Service Accounts',
    kind: 'ServiceAccount',
    columns: resourceColumns.serviceaccounts,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  poddisruptionbudgets: {
    label: 'Pod Disruption Budgets',
    kind: 'PodDisruptionBudget',
    columns: resourceColumns.poddisruptionbudgets,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  networkpolicies: {
    label: 'Network Policies',
    kind: 'NetworkPolicy',
    columns: resourceColumns.networkpolicies,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  virtualservices: {
    label: 'Virtual Services',
    kind: 'VirtualService',
    columns: resourceColumns.virtualservices,
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  events: {
    label: 'Events',
    columns: resourceColumns.events,
    supports: { events: false, logs: false, history: false, statusFilter: true },
  },
  helmreleases: {
    label: 'Helm Releases',
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
