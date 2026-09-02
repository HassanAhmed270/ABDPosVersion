import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  base: mode === 'electron' ? './' : '/',
  build: mode === 'electron' ? { outDir: 'dist-electron' } : {},
  server: {
    port: 5173,
    // Forward every JSON/API-style call to the Express backend (main.js) on :3000.
    // The backend is API-only now (see progress.md "EJS removal") — this dev
    // server is the only UI. In production, `npm run build-frontend` (root
    // package.json) builds this into frontend/dist, which main.js serves
    // directly, so there's no separate frontend deployment needed.
    proxy: {
      '/auth': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/product': 'http://localhost:3000',
      '/customer': 'http://localhost:3000',
      '/billing': 'http://localhost:3000',
      '/supplier': 'http://localhost:3000',
      '/dashboard/load': 'http://localhost:3000',
    },
  },
}))