import { useEffect, useState } from 'react'
import type { VersionInfo } from '../types'

export function useVersionInfo() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)

  useEffect(() => {
    const fetchVersion = () => {
      fetch('/api/version').then(r => r.json()).then(setVersionInfo).catch(console.error)
    }
    fetchVersion()
    const id = window.setInterval(fetchVersion, 60 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])

  return versionInfo
}
