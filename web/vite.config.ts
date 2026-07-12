import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api/* to the spider-api server, so the browser makes
// same-origin requests and no CORS config is needed on the API for local dev.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
