import { useEffect, useRef, useState } from 'react'
import { objectKey } from '../resources'
import type { Envelope } from '../types'

type ResourceStreamOptions = {
  onReset: () => void
  onSelectedDeleted: (key: string) => void
}

export function useResourceStream(ctx: string, resource: string, { onReset, onSelectedDeleted }: ResourceStreamOptions) {
  const [items, setItems] = useState<Map<string, any>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    setItems(new Map())
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
        if (env.type === 'ADDED' || env.type === 'MODIFIED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.set(uid, env.object)
            return next
          })
        } else if (env.type === 'DELETED') {
          setIsLoading(false)
          setLoadError(null)
          const uid = objectKey(env.object)
          setItems(prev => {
            const next = new Map(prev)
            next.delete(uid)
            return next
          })
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
