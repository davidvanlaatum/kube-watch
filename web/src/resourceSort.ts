import { eventTimestamp } from './resourceColumns'
import { resourceDefinition } from './resourceRegistry'
import type { SortDirection, SortState } from './types'

export function sortItems(resource: string, values: any[], sort: SortState) {
  if (sort) {
    const sortValue = resourceDefinition(resource)?.columns.find(column => column.id === sort.columnId)?.sortValue ?? nameSortValue
    return values.sort((a, b) => compareSortValues(sortValue(a), sortValue(b), sort.direction))
  }
  if (resource === 'events') return values.sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
  return values.sort((a, b) => nameSortValue(a).localeCompare(nameSortValue(b)))
}

export function nextSort(current: SortState, columnId: string): SortState {
  if (current?.columnId !== columnId) return { columnId, direction: 'asc' }
  if (current.direction === 'asc') return { columnId, direction: 'desc' }
  return null
}

function compareSortValues(a: string | number, b: string | number, direction: SortDirection) {
  const result = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  return direction === 'asc' ? result : -result
}

function nameSortValue(object: any) {
  return object.metadata?.name || ''
}
