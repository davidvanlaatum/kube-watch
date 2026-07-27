import { useCallback, useState } from 'react'
import type { DetailsTab } from '../types'

export function useDetailsState() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('yaml')
  const [isDetailsMaximized, setIsDetailsMaximized] = useState(false)

  const resetDetailsView = useCallback(() => {
    setDetailsTab('yaml')
    setIsDetailsMaximized(false)
  }, [])

  const closeDetails = useCallback(() => {
    setSelectedKey(null)
    resetDetailsView()
  }, [resetDetailsView])

  const handleSelectedResourceDeleted = useCallback((key: string) => {
    setSelectedKey(previousKey => {
      if (previousKey !== key) return previousKey
      resetDetailsView()
      return null
    })
  }, [resetDetailsView])

  return {
    selectedKey,
    setSelectedKey,
    detailsTab,
    setDetailsTab,
    isDetailsMaximized,
    setIsDetailsMaximized,
    resetDetailsView,
    closeDetails,
    handleSelectedResourceDeleted,
  }
}
