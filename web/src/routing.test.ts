import { afterEach, describe, expect, it } from 'vitest'
import { defaultResource, resourceOptions } from './resources'
import { currentViewRoute, viewRoutePath } from './routing'

describe('routing', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('preserves routes for every registered resource', () => {
    for (const resource of resourceOptions) {
      window.history.replaceState(null, '', `/view/dev/${resource}`)

      expect(currentViewRoute()).toEqual({ ctx: 'dev', resource })
      expect(viewRoutePath('dev', resource)).toBe(`/view/dev/${resource}`)
    }
  })

  it('falls back to the default resource for unknown routes and route writes', () => {
    window.history.replaceState(null, '', '/view/dev/unknown')

    expect(currentViewRoute()).toEqual({ ctx: 'dev', resource: defaultResource })
    expect(viewRoutePath('dev', 'unknown')).toBe(`/view/dev/${defaultResource}`)
  })
})
