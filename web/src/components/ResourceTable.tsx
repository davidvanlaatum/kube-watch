import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
} from '@mui/material'
import type { Column, SortState } from '../types'

type ResourceTableProps = {
  columns: Column[]
  items: any[]
  now: number
  selectedKey: string | null
  detailsOffset: number
  hasSelectedItem: boolean
  sort: SortState
  objectKey: (object: any) => string
  nextSort: (current: SortState, header: string) => SortState
  onSortChange: (updater: (sort: SortState) => SortState) => void
  onSelectKey: (updater: (key: string | null) => string | null) => void
  onSelectionChanged: () => void
}

export function ResourceTable({
  columns,
  items,
  now,
  selectedKey,
  detailsOffset,
  hasSelectedItem,
  sort,
  objectKey,
  nextSort,
  onSortChange,
  onSelectKey,
  onSelectionChanged,
}: ResourceTableProps) {
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      className="resource-table"
      sx={{ maxHeight: hasSelectedItem ? `max(180px, calc(100vh - 190px - ${detailsOffset}px))` : 'calc(100vh - 190px)' }}
    >
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {columns.map(column => {
              const active = sort?.header === column.header
              return (
                <TableCell key={column.header} align={column.align} sortDirection={active ? sort.direction : false}>
                  <TableSortLabel
                    active={active}
                    direction={active ? sort.direction : 'asc'}
                    onClick={() => onSortChange(prev => nextSort(prev, column.header))}
                  >
                    {column.header}
                  </TableSortLabel>
                </TableCell>
              )
            })}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item: any) => {
            const key = objectKey(item)
            return (
              <TableRow
                key={key}
                selected={selectedKey === key}
                hover
                sx={{ cursor: 'pointer' }}
                onClick={() => onSelectKey(prev => {
                  const next = prev === key ? null : key
                  if (next !== prev) {
                    onSelectionChanged()
                  }
                  return next
                })}
              >
                {columns.map(column => <TableCell key={column.header} align={column.align}>{column.value(item, now)}</TableCell>)}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
