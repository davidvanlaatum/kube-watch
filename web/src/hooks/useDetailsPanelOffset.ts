import { useEffect, useRef, useState } from 'react'
import type { DetailsTab } from '../types'

type DetailsPanelOffsetOptions = {
  isOpen: boolean
  selectionKey: string | null
  detailsTab: DetailsTab
  showFullDetails: boolean
  isMaximized: boolean
  historyLength: number
  historyLoading: boolean
  logEntryCount: number
  eventCount: number
}

export function useDetailsPanelOffset({
  isOpen,
  selectionKey,
  detailsTab,
  showFullDetails,
  isMaximized,
  historyLength,
  historyLoading,
  logEntryCount,
  eventCount,
}: DetailsPanelOffsetOptions) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (!isOpen || isMaximized || !panelRef.current) {
      setOffset(0)
      return
    }

    const updateOffset = () => {
      const height = panelRef.current?.getBoundingClientRect().height || 0
      setOffset(Math.ceil(height + 24))
    }
    updateOffset()

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateOffset)
      observer.observe(panelRef.current)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateOffset)
    return () => window.removeEventListener('resize', updateOffset)
  }, [isOpen, selectionKey, detailsTab, showFullDetails, isMaximized, historyLength, historyLoading, logEntryCount, eventCount])

  return { panelRef, offset }
}
