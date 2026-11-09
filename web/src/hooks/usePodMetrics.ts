import { useCallback, useEffect, useRef, useState } from 'react'
import {
  POD_METRIC_REFRESH_INTERVAL_MS,
  updatePodMetricHistory,
  type PodMetricHistoryPoint,
  type PodMetricsSnapshot,
} from '../podMetrics'

type MetricsState = {
  context: string
  data: PodMetricsSnapshot | null
  loading: boolean
  error: string | null
}

const emptyHistory = new Map<string, PodMetricHistoryPoint[]>()

export function usePodMetrics(context: string, selectedPodNames: string[], now?: number) {
  const [state, setState] = useState<MetricsState>({
    context: '',
    data: null,
    loading: false,
    error: null,
  })
  const [history, setHistory] = useState<Map<string, PodMetricHistoryPoint[]>>(emptyHistory)
  const [refreshKey, setRefreshKey] = useState(0)
  const previousContext = useRef(context)

  useEffect(() => {
    let active = true
    let timeout: number | undefined
    let controller: AbortController | null = null

    if (previousContext.current !== context) {
      previousContext.current = context
      setHistory(new Map())
    }

    setState(current => current.context === context
      ? { ...current, loading: Boolean(context) && !current.data, error: null }
      : { context, data: null, loading: Boolean(context), error: null })

    if (!context) {
      setState({ context, data: null, loading: false, error: null })
      return () => {
        active = false
      }
    }

    const poll = async () => {
      const requestController = new AbortController()
      controller = requestController
      try {
        const response = await fetch(`/api/pod-metrics/${encodeURIComponent(context)}`, {
          signal: requestController.signal,
        })
        const payload = await response.json() as PodMetricsSnapshot & { error?: string }
        if (!response.ok) {
          throw new Error(payload.error || `Pod metrics request failed (${response.status})`)
        }
        if (!Array.isArray(payload.pods) || typeof payload.namespace !== 'string') {
          throw new Error('Pod metrics response is incomplete')
        }
        if (!active || requestController.signal.aborted) return
        setState({
          context,
          data: payload,
          loading: false,
          error: null,
        })
      } catch (error) {
        if (!active || requestController.signal.aborted) return
        setState(current => ({
          context,
          data: current.context === context ? current.data : null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      } finally {
        if (active) {
          timeout = window.setTimeout(poll, POD_METRIC_REFRESH_INTERVAL_MS)
        }
      }
    }

    void poll()
    return () => {
      active = false
      if (timeout !== undefined) window.clearTimeout(timeout)
      controller?.abort()
    }
  }, [context, refreshKey])

  useEffect(() => {
    const snapshot = state.data
    if (state.context !== context) return
    const historyTime = now === undefined ? snapshot?.retrievedAt : new Date(now).toISOString()
    setHistory(previous => updatePodMetricHistory(
      previous,
      selectedPodNames,
      snapshot?.pods || [],
      historyTime,
    ))
  }, [context, now, selectedPodNames, state.context, state.data])

  const refresh = useCallback(() => setRefreshKey(key => key + 1), [])
  const currentState = state.context === context
    ? state
    : { context, data: null, loading: Boolean(context), error: null }

  return {
    data: currentState.data,
    error: currentState.error,
    history: state.context === context ? history : emptyHistory,
    isLoading: currentState.loading,
    refresh,
  }
}
