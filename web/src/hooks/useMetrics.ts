import { useEffect, useState } from 'react'
import { supportsMetrics, type MetricsSnapshot } from '../metrics'

export function useMetrics(ctx: string, resource: string) {
  const [state, setState] = useState<{ key: string; snapshot?: MetricsSnapshot; error?: string }>({ key: '' })
  const key = `${ctx}/${resource}`
  useEffect(() => {
    if (!ctx || !supportsMetrics(resource)) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    setState({ key })
    const poll = async () => {
      try {
        const response = await fetch(`/api/metrics/${encodeURIComponent(ctx)}/${resource}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Metrics request failed (${response.status})`)
        const snapshot: MetricsSnapshot = await response.json()
        if (!disposed) setState({ key, snapshot, error: snapshot.error })
      } catch (error) {
        if (!disposed) setState({ key, error: error instanceof Error ? error.message : 'Metrics unavailable' })
      } finally {
        if (!disposed) timer = setTimeout(poll, 15_000)
      }
    }
    void poll()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [ctx, resource, key])
  return state.key === key ? state : { key }
}
