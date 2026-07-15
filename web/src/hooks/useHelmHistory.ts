import { useEffect, useState } from 'react'
import type { DetailsTab } from '../types'

export function useHelmHistory(ctx: string, resource: string, selectedItem: any, detailsTab: DetailsTab) {
  const [history, setHistory] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHistory([])
    setError(null)

    if (!ctx || !selectedItem || resource !== 'helmreleases' || detailsTab !== 'history') {
      setLoading(false)
      return
    }

    const driver = selectedItem.status?.storageDriver || 'secrets'
    const releaseName = selectedItem.metadata?.name || ''
    if (!releaseName) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    fetch(`/api/helm-history/${encodeURIComponent(ctx)}/${encodeURIComponent(driver)}/${encodeURIComponent(releaseName)}`, {
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) {
        throw new Error(await response.text() || `Helm history failed with ${response.status}`)
      }
      return response.json()
    }).then(nextHistory => {
      setHistory(Array.isArray(nextHistory) ? nextHistory : [])
      setError(null)
    }).catch(fetchError => {
      if (fetchError.name === 'AbortError') return
      setError(fetchError.message || String(fetchError))
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    })

    return () => controller.abort()
  }, [ctx, resource, selectedItem, detailsTab])

  return { history, loading, error }
}
