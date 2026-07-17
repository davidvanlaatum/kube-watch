import { describe, expect, it } from 'vitest'
import { highlightedLogEntryCount } from './DetailsDrawer'

describe('highlightedLogEntryCount', () => {
  it('highlights five tail windows with a bounded live-stream fallback', () => {
    expect(highlightedLogEntryCount(0)).toBe(200)
    expect(highlightedLogEntryCount(50)).toBe(250)
    expect(highlightedLogEntryCount(200)).toBe(1_000)
  })

  it('caps highlighting for large tail sizes', () => {
    expect(highlightedLogEntryCount(5_000)).toBe(1_000)
  })
})
