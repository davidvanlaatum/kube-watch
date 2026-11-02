import { useEffect, useRef, useState } from 'react'
import { objectKey } from '../resourceUtils'
import type { Envelope } from '../types'

type ResourceStreamOptions = {
  onReset: () => void
  onSelectedDeleted: (key: string) => void
}

export function useResourceStream(ctx: string, resource: string, { onReset, onSelectedDeleted }: ResourceStreamOptions) {
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const itemsRef = useRef<Map<string, any>>(new Map())
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    itemsRef.current = new Map()
    setItems(itemsRef.current)
    setLoadError(null)
    onReset()

    if (!ctx) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    const url = `/sse/${encodeURIComponent(ctx)}/${encodeURIComponent(resource)}`
    const es = new EventSource(url)
    es.onmessage = (ev) => {
      try {
        const env: Envelope = JSON.parse(ev.data)
        if (env.type === 'SNAPSHOT' && Array.isArray(env.objects)) {
          const next = new Map(env.objects.map(object => [objectKey(object), object]))
          for (const key of itemsRef.current.keys()) {
            if (!next.has(key)) onSelectedDeleted(key)
          }
          itemsRef.current = next
          setItems(next)
          setIsLoading(false)
          setLoadError(null)
        } else if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          const next = new Map(itemsRef.current)
          next.set(uid, env.object)
          itemsRef.current = next
          setItems(next)
        } else if (env.type === 'DELETED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          const next = new Map(itemsRef.current)
          next.delete(uid)
          itemsRef.current = next
          setItems(next)
          onSelectedDeleted(uid)
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
  }, [ctx, resource, onReset, onSelectedDeleted])

  return { items, isLoading, loadError }
}
