import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({mode}) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.GO_BACKEND || 'https://localhost:9443',
        changeOrigin: true,
        secure: false,
      },
      '/sse': {
        target: process.env.GO_BACKEND || 'https://localhost:9443',
        changeOrigin: true,
        secure: false,
      },
      '/logs': {
        target: process.env.GO_BACKEND || 'https://localhost:9443',
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
  }
}))
