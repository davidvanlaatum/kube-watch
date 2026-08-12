import { describe, expect, it } from 'vitest'
import { emptyFilters, matchesFilters } from './resourceFilters'

describe('matchesFilters', () => {
  it('excludes completed pods from the not ready filter', () => {
    const notReadyFilters = { ...emptyFilters, notReadyOnly: true }

    expect(matchesFilters('pods', {
      status: {
        phase: 'Succeeded',
        containerStatuses: [{ ready: false }],
      },
    }, notReadyFilters)).toBe(false)

    expect(matchesFilters('pods', {
      status: {
        phase: 'Pending',
        containerStatuses: [{ ready: false }],
      },
    }, notReadyFilters)).toBe(true)

    expect(matchesFilters('pods', {
      status: {
        phase: 'Failed',
        containerStatuses: [{ ready: false }],
      },
    }, notReadyFilters)).toBe(true)
  })
})
