import {
  Autocomplete,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
} from '@mui/material'
import type { TableFilters } from '../types'

type ResourceFiltersProps = {
  resource: string
  filters: TableFilters
  showStatusFilter: boolean
  statusFilterSuggestions: string[]
  labelFilterSuggestions: string[]
  shownCount: number
  totalCount: number
  hasActiveFilters: boolean
  onFiltersChange: (updater: (filters: TableFilters) => TableFilters) => void
  onClearFilters: () => void
}

export function ResourceFilters({
  resource,
  filters,
  showStatusFilter,
  statusFilterSuggestions,
  labelFilterSuggestions,
  shownCount,
  totalCount,
  hasActiveFilters,
  onFiltersChange,
  onClearFilters,
}: ResourceFiltersProps) {
  return (
    <Paper component="section" aria-label="Table filters" variant="outlined" sx={{ mb: 2, p: 1.5 }}>
      <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          label="Name contains"
          type="search"
          size="small"
          value={filters.name}
          onChange={event => onFiltersChange(prev => ({ ...prev, name: event.target.value }))}
          placeholder="api"
        />
        {showStatusFilter && (
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="status-filter-label">Status equals</InputLabel>
            <Select
              labelId="status-filter-label"
              id="status-filter"
              label="Status equals"
              value={filters.status}
              onChange={event => onFiltersChange(prev => ({ ...prev, status: event.target.value }))}
            >
              <MenuItem value=""><em>Any status</em></MenuItem>
              {statusFilterSuggestions.map(status => (
                <MenuItem key={status} value={status}>{status}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        <Autocomplete
          freeSolo
          openOnFocus
          options={labelFilterSuggestions}
          value={filters.labels}
          inputValue={filters.labels}
          onInputChange={(_, value) => onFiltersChange(prev => ({ ...prev, labels: value }))}
          onChange={(_, value) => {
            if (typeof value === 'string') {
              onFiltersChange(prev => ({ ...prev, labels: value }))
            }
          }}
          sx={{ minWidth: 340 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Labels"
              type="search"
              size="small"
              placeholder="app.kubernetes.io/name: simtool-api"
            />
          )}
        />
        {resource === 'pods' && (
          <FormControlLabel
            control={(
              <Checkbox
                checked={filters.podRestartsOnly}
                onChange={event => onFiltersChange(prev => ({ ...prev, podRestartsOnly: event.target.checked }))}
              />
            )}
            label="Restarts > 0"
          />
        )}
        {(resource === 'pods' || resource === 'deployments' || resource === 'statefulsets') && (
          <FormControlLabel
            control={(
              <Checkbox
                checked={filters.notReadyOnly}
                onChange={event => onFiltersChange(prev => ({ ...prev, notReadyOnly: event.target.checked }))}
              />
            )}
            label="Not ready"
          />
        )}
        {hasActiveFilters && (
          <Button type="button" variant="outlined" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
        <Chip size="small" variant="outlined" label={`${shownCount}/${totalCount} shown`} sx={{ ml: 'auto' }} />
      </Stack>
    </Paper>
  )
}
