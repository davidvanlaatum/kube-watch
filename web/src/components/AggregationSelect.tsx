import { FormControl, InputLabel, MenuItem, Select } from '@mui/material'
import { useId } from 'react'
import { aggregationLabels, type Aggregation } from '../metrics'

export function AggregationSelect({ value, onChange }: { value: Aggregation; onChange: (value: Aggregation) => void }) {
  const labelId = useId()
  return <FormControl size="small" sx={{ minWidth: 160 }}>
    <InputLabel id={labelId}>Pod aggregation</InputLabel>
    <Select labelId={labelId} label="Pod aggregation" value={value} onChange={event => onChange(event.target.value as Aggregation)}>
      {Object.entries(aggregationLabels).map(([key, label]) => <MenuItem key={key} value={key}>{label}</MenuItem>)}
    </Select>
  </FormControl>
}
