import { Alert, Stack, useTheme } from '@mui/material'

type BackendLogEntry = { id: string; message: string; time: string; count: number }

type BackendLogToastsProps = {
  logs: BackendLogEntry[]
  onDismiss: (id: string) => void
}

export function BackendLogToasts({ logs, onDismiss }: BackendLogToastsProps) {
  const theme = useTheme()
  if (logs.length === 0) return null

  return (
    <Stack
      spacing={1}
      role="status"
      aria-live="polite"
      sx={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: theme.zIndex.snackbar,
        maxWidth: 560,
        width: 'min(560px, calc(100vw - 32px))',
      }}
    >
      {logs.map(entry => (
        <Alert
          key={entry.id}
          severity="error"
          variant="filled"
          elevation={6}
          onClose={() => onDismiss(entry.id)}
        >
          {entry.message}{entry.count > 1 ? ` (${entry.count}x)` : ''}
        </Alert>
      ))}
    </Stack>
  )
}
