import { useEffect, useMemo, useRef, useState } from 'react'
import { eventMatchesResource, objectKey, sortItems } from '../resources'
import type { Envelope } from '../types'

export function useResourceEvents(ctx: string, resource: string, selectedItem: any, supportsEvents: boolean) {
  const [events, setEvents] = useState<Map<string, any>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const selectedUid = selectedItem?.metadata?.uid || ''
  const selectedName = selectedItem?.metadata?.name || ''
  const selectedNamespace = selectedItem?.metadata?.namespace || ''
  const selectedKind = selectedItem?.kind || ''
  const selectedResource = useMemo(() => {
    if (!selectedName && !selectedUid) return null
    return {
      kind: selectedKind,
      metadata: {
        uid: selectedUid,
        name: selectedName,
        namespace: selectedNamespace,
      },
    }
  }, [selectedKind, selectedName, selectedNamespace, selectedUid])

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    setEvents(new Map())
    setError(null)

    if (!ctx || !selectedResource || !supportsEvents) {
      setLoading(false)
      return
    }

    setLoading(true)
    const es = new EventSource(`/sse/${encodeURIComponent(ctx)}/events`)
    const emptyEventsTimer = window.setTimeout(() => {
      setLoading(false)
    }, 2500)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'SYNCED') {
          window.clearTimeout(emptyEventsTimer)
          setLoading(false)
          setError(null)
          return
        }
        if (env.error) {
          window.clearTimeout(emptyEventsTimer)
          setLoading(false)
          setError(env.error)
          return
        }
        if (!env.object || !eventMatchesResource(env.object, selectedResource, resource)) {
          return
        }
        window.clearTimeout(emptyEventsTimer)
        setLoading(false)
        setError(null)
        const uid = objectKey(env.object)
        if (env.type === 'DELETED') {
          setEvents(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
          return
        }
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          setEvents(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        }
      } catch (parseError) {
        console.warn('event stream parse', parseError)
      }
    }
    es.onerror = (streamError) => {
      window.clearTimeout(emptyEventsTimer)
      setLoading(false)
      setError('Event stream interrupted; waiting for EventSource to reconnect')
      console.warn('event stream error', streamError)
    }
    esRef.current = es
    return () => {
      window.clearTimeout(emptyEventsTimer)
      es.close()
      esRef.current = null
    }
  }, [ctx, resource, selectedResource, supportsEvents])

  return {
    events,
    sortedEvents: sortItems('events', [...events.values()], null),
    loading,
    error,
  }
}
