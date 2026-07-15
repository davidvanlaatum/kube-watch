import { useEffect, useRef, useState } from 'react'
import type { BackendLogEntry, BackendLogEnvelope } from '../types'

const defaultDisplayMillis = 12_000

export function useBackendLogs(displayMillis = defaultDisplayMillis) {
  const [logs, setLogs] = useState<BackendLogEntry[]>([])
  const timersRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const es = new EventSource('/api/backend-logs')
    es.onmessage = (ev) => {
      try {
        const env: BackendLogEnvelope = JSON.parse(ev.data)
        if (env.type !== 'BACKEND_LOG' || !env.error) return
        const message = env.error
        const time = env.log?.time || new Date().toISOString()
        const id = message
        setLogs(prev => {
          const existing = prev.find(entry => entry.id === id)
          if (existing) {
            return [
              { ...existing, time, count: existing.count + 1 },
              ...prev.filter(entry => entry.id !== id),
            ].slice(0, 5)
          }
          return [{ id, message, time, count: 1 }, ...prev].slice(0, 5)
        })
        const existingTimer = timersRef.current.get(id)
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer)
        }
        const timer = window.setTimeout(() => {
          setLogs(prev => prev.filter(entry => entry.id !== id))
          timersRef.current.delete(id)
        }, displayMillis)
        timersRef.current.set(id, timer)
      } catch (error) {
        console.warn('backend log stream parse', error)
      }
    }
    es.onerror = (error) => {
      console.warn('backend log stream error', error)
    }
    return () => {
      es.close()
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer)
      }
      timersRef.current.clear()
    }
  }, [displayMillis])

  const dismissLog = (id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setLogs(prev => prev.filter(entry => entry.id !== id))
  }

  return { logs, dismissLog }
}
