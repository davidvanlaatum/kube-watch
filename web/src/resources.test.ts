import { describe, expect, it } from 'vitest'
import { eventMatchesResource, resourceDefinition, resourceOptions, supportedResource } from './resources'

const expectedResources = {
  pods: {
    kind: 'Pod',
    columns: ['name', 'ready', 'status', 'restarts', 'age', 'node'],
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  deployments: {
    kind: 'Deployment',
    columns: ['name', 'ready', 'updated', 'available', 'age'],
    supports: { events: true, logs: true, history: false, statusFilter: true },
  },
  statefulsets: {
    kind: 'StatefulSet',
    columns: ['name', 'ready', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  replicasets: {
    kind: 'ReplicaSet',
    columns: ['name', 'desired', 'current', 'ready', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  services: {
    kind: 'Service',
    columns: ['name', 'type', 'clusterIp', 'externalIp', 'ports', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  jobs: {
    kind: 'Job',
    columns: ['name', 'status', 'completions', 'duration', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: true },
  },
  cronjobs: {
    kind: 'CronJob',
    columns: ['name', 'schedule', 'timezone', 'suspend', 'active', 'lastSchedule', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  hpas: {
    kind: 'HorizontalPodAutoscaler',
    columns: ['name', 'reference', 'targets', 'minPods', 'maxPods', 'replicas', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  configmaps: {
    kind: 'ConfigMap',
    columns: ['name', 'data', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  secrets: {
    kind: 'Secret',
    columns: ['name', 'type', 'data', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  serviceaccounts: {
    kind: 'ServiceAccount',
    columns: ['name', 'secrets', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  poddisruptionbudgets: {
    kind: 'PodDisruptionBudget',
    columns: ['name', 'minAvailable', 'maxUnavailable', 'allowedDisruptions', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  networkpolicies: {
    kind: 'NetworkPolicy',
    columns: ['name', 'podSelector', 'age'],
    supports: { events: true, logs: false, history: false, statusFilter: false },
  },
  events: {
    kind: undefined,
    columns: ['lastSeen', 'type', 'reason', 'object', 'message'],
    supports: { events: false, logs: false, history: false, statusFilter: true },
  },
  helmreleases: {
    kind: 'HelmRelease',
    columns: ['name', 'namespace', 'status', 'chart', 'appVersion', 'revision', 'updated'],
    supports: { events: false, logs: false, history: true, statusFilter: true },
  },
}

describe('resourceRegistry', () => {
  it('preserves every supported resource and its table/detail contract', () => {
    expect(resourceOptions).toEqual(Object.keys(expectedResources))

    for (const [resource, expected] of Object.entries(expectedResources)) {
      const definition = resourceDefinition(resource)
      expect(definition?.kind).toBe(expected.kind)
      expect(definition?.columns.map(column => column.id)).toEqual(expected.columns)
      expect(definition?.columns.every(column => Boolean(column.sortValue))).toBe(true)
      expect(definition?.supports).toEqual(expected.supports)
      expect(supportedResource(resource)).toBe(true)
    }
    expect(supportedResource('unknown')).toBe(false)
  })

  it('uses the registry kind when matching UID-less selected-resource events', () => {
    const deployment = {
      metadata: { name: 'api', namespace: 'default' },
    }
    const matchingEvent = {
      involvedObject: { name: 'api', namespace: 'default', kind: 'Deployment' },
    }
    const mismatchedEvent = {
      involvedObject: { name: 'api', namespace: 'default', kind: 'StatefulSet' },
    }

    expect(eventMatchesResource(matchingEvent, deployment, 'deployments')).toBe(true)
    expect(eventMatchesResource(mismatchedEvent, deployment, 'deployments')).toBe(false)
  })
})
