import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({mode}) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.GO_BACKEND || 'https://127.0.0.1:9443',
        changeOrigin: true,
        secure: false,
      },
      '/sse': {
        target: process.env.GO_BACKEND || 'https://127.0.0.1:9443',
        changeOrigin: true,
        secure: false,
      },
      '/logs': {
        target: process.env.GO_BACKEND || 'https://127.0.0.1:9443',
        changeOrigin: true,
        secure: false,
      }
    }
  },
  build: {
    emptyOutDir: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: './src/test/setup.ts',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'json', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        statements: 50,
        branches: 35,
        functions: 40,
        lines: 50,
      },
    },
  }
}))
