import { defaultResource, supportedResource } from './resources'
import type { ViewRoute } from './types'

export function currentViewRoute(): ViewRoute {
  if (typeof window === 'undefined') return { ctx: '', resource: defaultResource }
  return parseViewRoute(window.location.pathname)
}

function parseViewRoute(pathname: string): ViewRoute {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'view') return { ctx: '', resource: defaultResource }

  const ctx = parts[1] ? safeDecodePathSegment(parts[1]) : ''
  const resource = supportedResource(parts[2]) ? parts[2] : defaultResource
  return { ctx, resource }
}

export function viewRoutePath(ctx: string, resource: string) {
  if (!ctx) return '/'
  const safeResource = supportedResource(resource) ? resource : defaultResource
  return `/view/${encodeURIComponent(ctx)}/${safeResource}`
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}
