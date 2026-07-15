import type { ReactNode } from 'react'

export type ContextInfo = { name: string; namespace: string }

export type VersionInfo = {
  version: string
  commit: string
  date: string
  latestVersion?: string
  latestUrl?: string
  updateAvailable: boolean
  checkError?: string
}

export type Envelope = { type?: string; object?: any; error?: string; info?: string }

export type BackendLogEnvelope = {
  type?: string
  error?: string
  info?: string
  log?: { time?: string; message?: string; attrs?: Record<string, string> }
}

export type BackendLogEntry = { id: string; message: string; time: string; count: number }

export type LogEnvelope = {
  type?: string
  pod?: string
  container?: string
  timestamp?: string
  line?: string
  error?: string
  info?: string
  seq?: number
}

export type LogEntry = { pod: string; container: string; timestamp: string; line: string; seq: number }

export type DetailsTab = 'yaml' | 'events' | 'logs' | 'history'

export type TableFilters = {
  name: string
  status: string
  labels: string
  podRestartsOnly: boolean
  notReadyOnly: boolean
}

export type Column = {
  header: string
  value: (object: any, now: number) => ReactNode
  align?: 'left' | 'center' | 'right'
  sortValue?: (object: any) => string | number
}

export type SortDirection = 'asc' | 'desc'
export type SortState = { header: string; direction: SortDirection } | null

export type ViewRoute = { ctx: string; resource: string }
