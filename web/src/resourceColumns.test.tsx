import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { eventTimestamp, isReady, podRestartCount, resourceColumns, resourceStatus } from './resourceColumns'

function value(resource: string, columnId: string, object: any) {
  const column = resourceColumns[resource].find(candidate => candidate.id === columnId)
  if (!column) throw new Error(`missing ${resource}.${columnId}`)
  return column.value(object)
}

function sortValue(resource: string, columnId: string, object: any) {
  const column = resourceColumns[resource].find(candidate => candidate.id === columnId)
  if (!column?.sortValue) throw new Error(`missing sort value for ${resource}.${columnId}`)
  return column.sortValue(object)
}

describe('resource column formatters', () => {
  it('formats service addresses and ports, including absent values', () => {
    expect(value('services', 'externalIp', {
      status: { loadBalancer: { ingress: [{ ip: '192.0.2.10' }, { hostname: 'lb.example' }] } },
    })).toBe('192.0.2.10,lb.example')
    expect(value('services', 'externalIp', {})).toBe('<none>')
    expect(value('services', 'clusterIp', {})).toBe('<none>')
    expect(value('services', 'ports', {
      spec: { ports: [{ port: 80, nodePort: 30080 }, { port: 443, protocol: 'UDP' }] },
    })).toBe('80:30080/TCP,443/UDP')
    expect(value('services', 'ports', {})).toBe('')
  })

  it('formats job status and duration fallbacks', () => {
    expect(value('jobs', 'status', { status: { succeeded: 1 } })).toBe('Complete')
    expect(value('jobs', 'status', { status: { failed: 1, active: 1 } })).toBe('Failed')
    expect(value('jobs', 'status', { status: { active: 1 } })).toBe('Running')
    expect(value('jobs', 'status', {})).toBe('')
    expect(value('jobs', 'duration', {})).toBe('<none>')
    expect(value('jobs', 'duration', {
      status: { startTime: '2026-01-01T00:00:00Z', completionTime: '2026-01-01T00:01:05Z' },
    })).toBe('1m')
    expect(sortValue('jobs', 'duration', {})).toBe(0)
  })

  it('formats HPA references and all supported metric target types', () => {
    expect(value('hpas', 'reference', {})).toBe('<none>')
    expect(value('hpas', 'reference', { spec: { scaleTargetRef: { kind: 'Deployment', name: 'api' } } })).toBe('Deployment/api')
    expect(value('hpas', 'targets', {})).toBe('<unknown>')
    expect(value('hpas', 'targets', {
      spec: { metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 80 } } },
        { type: 'Pods', pods: { target: { averageValue: '2' } } },
        { type: 'Object', object: { target: { value: '5' } } },
        { type: 'External', external: { target: {} } },
        { type: 'Unknown' },
      ] },
      status: { currentMetrics: [
        { resource: { current: { averageUtilization: 40 } } },
        { pods: { current: { averageValue: '1' } } },
        { object: { current: { value: '3' } } },
        { external: { current: {} } },
      ] },
    })).toBe('40/80 cpu, 1/2 pods, 3/5 object, <unknown>/<unknown> external, <unknown>/Unknown')
  })

  it('formats selectors, virtual services, events, and Helm values', () => {
    expect(value('networkpolicies', 'podSelector', { spec: { podSelector: { matchLabels: { app: 'api', tier: 'web' } } } })).toBe('app=api,tier=web')
    expect(value('networkpolicies', 'podSelector', {})).toBe('<none>')
    expect(value('virtualservices', 'gateways', {})).toBe('<none>')
    expect(value('virtualservices', 'hosts', { spec: { hosts: ['api.example', 'www.example'] } })).toBe('api.example,www.example')
    expect(value('events', 'object', { involvedObject: { kind: 'Pod', name: 'api-1' } })).toBe('Pod/api-1')
    expect(value('events', 'object', {})).toBe('<none>')
    expect(value('helmreleases', 'chart', { spec: { chart: 'api', version: '1.2.3' } })).toBe('api-1.2.3')
    expect(value('helmreleases', 'chart', { spec: {} })).toBe('')
    expect(value('helmreleases', 'status', {})).toBe('')
  })

  it('handles pod readiness, status precedence, and restart totals', () => {
    const pod = {
      spec: { containers: [{ name: 'api' }, { name: 'sidecar' }] },
      status: {
        phase: 'Pending',
        initContainerStatuses: [{ restartCount: 2 }],
        containerStatuses: [
          { ready: true, restartCount: 1, state: { waiting: { reason: 'CrashLoopBackOff' } } },
          { ready: false, restartCount: 3, state: { terminated: { reason: 'Error' } } },
        ],
      },
    }
    expect(value('pods', 'ready', pod)).toBe('1/2')
    expect(value('pods', 'status', pod)).toBe('CrashLoopBackOff')
    expect(podRestartCount(pod)).toBe(6)
    expect(isReady('pods', pod)).toBe(false)
    expect(isReady('pods', { status: { containerStatuses: [{ ready: true }] } })).toBe(true)
    expect(isReady('pods', {})).toBe(false)
    expect(resourceStatus('pods', pod)).toBe('CrashLoopBackOff')
    expect(resourceStatus('events', { type: 'Warning' })).toBe('Warning')
  })

  it('uses valid timestamps for event sorting and zero for invalid or missing values', () => {
    const timestamp = '2026-01-02T03:04:05Z'
    expect(eventTimestamp({ lastTimestamp: timestamp, eventTime: 'invalid' })).toBe(new Date(timestamp).getTime())
    expect(eventTimestamp({ eventTime: timestamp })).toBe(new Date(timestamp).getTime())
    expect(eventTimestamp({ metadata: { creationTimestamp: timestamp } })).toBe(new Date(timestamp).getTime())
    expect(Number.isNaN(eventTimestamp({ lastTimestamp: 'invalid' }))).toBe(true)
    expect(sortValue('events', 'lastSeen', {})).toBe(0)
  })

  it('renders a resource name column with copy affordance', () => {
    render(value('pods', 'name', { metadata: { name: 'api-1' } }) as ReactElement)
    expect(screen.getByText('api-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy api-1' })).toBeInTheDocument()
  })
})
