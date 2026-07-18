import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        // Backend URL the dev server proxies to. Override with DOCSEEK_API_TARGET
        // to point at a backend running on a non-default port (used by the
        // screenshot capture script to stay isolated from a live backend).
        target: process.env.DOCSEEK_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
