import { Box, CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { AppHeader } from './components/AppHeader'
import { KubeWatchBody } from './components/KubeWatchBody'
import { useContexts } from './hooks/useContexts'
import { useVersionInfo } from './hooks/useVersionInfo'
import { useViewRoute } from './hooks/useViewRoute'
import { contextSelectOptions, versionLabel } from './resources'

const prefersDarkMode = typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const theme = createTheme({
  palette: {
    mode: prefersDarkMode ? 'dark' : 'light',
    primary: {
      main: '#2563eb',
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial",
  },
  components: {
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        },
        body: {
          fontSize: 13,
        },
      },
    },
    MuiTooltip: {
      defaultProps: {
        arrow: true,
      },
    },
  },
})

export default function App() {
  const { ctx, setCtx, resource, setResource } = useViewRoute()
  const contexts = useContexts()
  const versionInfo = useVersionInfo()
  const contextOptions = contextSelectOptions(contexts, ctx)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box className="app" sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <AppHeader
          versionInfo={versionInfo}
          versionLabel={versionLabel}
          contexts={contextOptions}
          ctx={ctx}
          resource={resource}
          onContextChange={setCtx}
          onResourceChange={setResource}
        />
        <KubeWatchBody ctx={ctx} resource={resource} />
      </Box>
    </ThemeProvider>
  )
}
