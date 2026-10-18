import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // The Pyodide kernel pulls its runtime with a dynamic `import()` of the
  // jsDelivr CDN URL, which only works in a module worker — the default IIFE
  // bundle would leave that import unsupported.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
    // The client imports the wire contract from `shared/`, which sits outside
    // Vite's root (`web/`), so dev has to be allowed to read it.
    fs: { allow: ['..'] },
  },
})
