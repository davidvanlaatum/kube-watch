import { useEffect, useState } from 'react'
import type { ContextInfo } from '../types'

export function useContexts() {
  const [contexts, setContexts] = useState<ContextInfo[]>([])

  useEffect(() => {
    fetch('/api/contexts').then(r => r.json()).then(setContexts).catch(console.error)
  }, [])

  return contexts
}
