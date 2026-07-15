import { useEffect, useRef, useState } from 'react'
import { currentViewRoute, viewRoutePath } from '../routing'

export function useViewRoute() {
  const initialRoute = useRef(currentViewRoute())
  const [ctx, setCtx] = useState<string>(initialRoute.current.ctx)
  const [resource, setResource] = useState<string>(initialRoute.current.resource)
  const routeSyncReadyRef = useRef(false)
  const handlingPopStateRef = useRef(false)

  useEffect(() => {
    const onPopState = () => {
      const next = currentViewRoute()
      handlingPopStateRef.current = true
      setCtx(next.ctx)
      setResource(next.resource)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const nextPath = viewRoutePath(ctx, resource)
    if (window.location.pathname !== nextPath) {
      if (routeSyncReadyRef.current && !handlingPopStateRef.current) {
        window.history.pushState(null, '', nextPath)
      } else {
        window.history.replaceState(null, '', nextPath)
      }
    }
    routeSyncReadyRef.current = true
    handlingPopStateRef.current = false
  }, [ctx, resource])

  return { ctx, setCtx, resource, setResource }
}
