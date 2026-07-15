import {
  AppBar,
  Box,
  Chip,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material'

type ContextInfo = { name: string; namespace: string }
type VersionInfo = {
  version: string
  commit: string
  date: string
  latestVersion?: string
  latestUrl?: string
  updateAvailable: boolean
  checkError?: string
}

type AppHeaderProps = {
  versionInfo: VersionInfo | null
  versionLabel: (version: string) => string
  contexts: ContextInfo[]
  ctx: string
  resource: string
  onContextChange: (context: string) => void
  onResourceChange: (resource: string) => void
}

const resourceOptions = [
  'pods',
  'deployments',
  'statefulsets',
  'replicasets',
  'services',
  'jobs',
  'cronjobs',
  'hpas',
  'configmaps',
  'secrets',
  'serviceaccounts',
  'poddisruptionbudgets',
  'networkpolicies',
  'events',
  'helmreleases',
]

export function AppHeader({
  versionInfo,
  versionLabel,
  contexts,
  ctx,
  resource,
  onContextChange,
  onResourceChange,
}: AppHeaderProps) {
  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar sx={{ gap: 2, alignItems: { xs: 'stretch', sm: 'center' }, flexDirection: { xs: 'column', sm: 'row' }, py: { xs: 1, sm: 0 } }}>
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <Typography variant="h6" component="h1">kube-watch</Typography>
          {versionInfo && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip size="small" label={versionLabel(versionInfo.version)} />
              {versionInfo.updateAvailable && versionInfo.latestVersion && versionInfo.latestUrl && (
                <Link href={versionInfo.latestUrl} target="_blank" rel="noreferrer" sx={{ fontSize: 13, fontWeight: 700 }}>
                  Update available: {versionInfo.latestVersion}
                </Link>
              )}
            </Stack>
          )}
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ minWidth: { sm: 420 } }}>
          <FormControl size="small" fullWidth>
            <InputLabel id="context-select-label">Context</InputLabel>
            <Select
              labelId="context-select-label"
              id="context-select"
              label="Context"
              value={ctx}
              onChange={event => onContextChange(event.target.value)}
            >
              <MenuItem value=""><em>Select context</em></MenuItem>
              {contexts.map(context => <MenuItem key={context.name} value={context.name}>{context.name} ({context.namespace})</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="resource-select-label">Resource</InputLabel>
            <Select
              labelId="resource-select-label"
              id="resource-select"
              label="Resource"
              value={resource}
              onChange={event => onResourceChange(event.target.value)}
            >
              {resourceOptions.map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
            </Select>
          </FormControl>
        </Stack>
      </Toolbar>
    </AppBar>
  )
}
