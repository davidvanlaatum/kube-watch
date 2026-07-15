import { Tooltip } from '@mui/material'
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

const RelativeAgeContext = createContext(Date.now())

type RelativeAgeProviderProps = {
  children: ReactNode
  refreshMs?: number
}

type RelativeAgeProps = {
  timestamp: string | undefined
  fallback?: ReactNode
  children?: (duration: string) => ReactNode
}

export function RelativeAgeProvider({ children, refreshMs = 30_000 }: RelativeAgeProviderProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), refreshMs)
    return () => window.clearInterval(id)
  }, [refreshMs])

  return (
    <RelativeAgeContext.Provider value={now}>
      {children}
    </RelativeAgeContext.Provider>
  )
}

export function RelativeAge({ timestamp, fallback = '', children }: RelativeAgeProps) {
  const now = useContext(RelativeAgeContext)
  const duration = relativeDurationSince(timestamp, now)
  if (!duration) return fallback

  return (
    <Tooltip title={formatLocalTimestamp(timestamp) || ''}>
      <span>{children ? children(duration) : duration}</span>
    </Tooltip>
  )
}

export function relativeDurationSince(timestamp: string | undefined, now = Date.now()) {
  if (!timestamp) return ''
  const timestampMillis = new Date(timestamp).getTime()
  if (!Number.isFinite(timestampMillis)) return ''
  return formatMillis(Math.max(0, now - timestampMillis))
}

export function formatDurationBetween(start: string, end: string) {
  return formatMillis(new Date(end).getTime() - new Date(start).getTime())
}

function formatLocalTimestamp(timestamp: string | undefined) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

function formatMillis(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
