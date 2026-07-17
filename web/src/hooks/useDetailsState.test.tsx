import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDetailsState } from './useDetailsState'

function DetailsStateHarness() {
  const state = useDetailsState()

  return (
    <>
      <output data-testid="selected-key">{state.selectedKey || ''}</output>
      <output data-testid="details-tab">{state.detailsTab}</output>
      <output data-testid="show-full">{String(state.showFullDetails)}</output>
      <output data-testid="is-maximized">{String(state.isDetailsMaximized)}</output>
      <button type="button" onClick={() => state.setSelectedKey('pod-1')}>Select</button>
      <button type="button" onClick={() => state.setDetailsTab('events')}>Events</button>
      <button type="button" onClick={() => state.setShowFullDetails(true)}>Show full</button>
      <button type="button" onClick={() => state.setIsDetailsMaximized(true)}>Maximize</button>
      <button type="button" onClick={state.resetDetailsView}>Reset view</button>
      <button type="button" onClick={state.closeDetails}>Close</button>
      <button type="button" onClick={() => state.handleSelectedResourceDeleted('pod-2')}>Delete other</button>
      <button type="button" onClick={() => state.handleSelectedResourceDeleted('pod-1')}>Delete selected</button>
    </>
  )
}

function expectDetailsState(selectedKey: string, tab: string, showFull: boolean, isMaximized = false) {
  expect(screen.getByTestId('selected-key')).toHaveTextContent(selectedKey)
  expect(screen.getByTestId('details-tab')).toHaveTextContent(tab)
  expect(screen.getByTestId('show-full')).toHaveTextContent(String(showFull))
  expect(screen.getByTestId('is-maximized')).toHaveTextContent(String(isMaximized))
}

describe('useDetailsState', () => {
  afterEach(cleanup)

  it('resets the details view without clearing the current selection', () => {
    render(<DetailsStateHarness />)

    act(() => {
      screen.getByRole('button', { name: 'Select' }).click()
      screen.getByRole('button', { name: 'Events' }).click()
      screen.getByRole('button', { name: 'Show full' }).click()
      screen.getByRole('button', { name: 'Maximize' }).click()
    })
    expectDetailsState('pod-1', 'events', true, true)

    act(() => {
      screen.getByRole('button', { name: 'Reset view' }).click()
    })
    expectDetailsState('pod-1', 'yaml', false)
  })

  it('only clears details when the deleted resource is selected', () => {
    render(<DetailsStateHarness />)

    act(() => {
      screen.getByRole('button', { name: 'Select' }).click()
      screen.getByRole('button', { name: 'Events' }).click()
      screen.getByRole('button', { name: 'Show full' }).click()
      screen.getByRole('button', { name: 'Maximize' }).click()
      screen.getByRole('button', { name: 'Delete other' }).click()
    })
    expectDetailsState('pod-1', 'events', true, true)

    act(() => {
      screen.getByRole('button', { name: 'Delete selected' }).click()
    })
    expectDetailsState('', 'yaml', false)
  })

  it('closes details and restores the default view', () => {
    render(<DetailsStateHarness />)

    act(() => {
      screen.getByRole('button', { name: 'Select' }).click()
      screen.getByRole('button', { name: 'Events' }).click()
      screen.getByRole('button', { name: 'Show full' }).click()
      screen.getByRole('button', { name: 'Maximize' }).click()
      screen.getByRole('button', { name: 'Close' }).click()
    })

    expectDetailsState('', 'yaml', false)
  })
})
