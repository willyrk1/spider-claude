import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two pages: the solver (index.html) and the casual "just play" table
// (play.html). `vite build --mode play` builds the play table alone, with
// relative asset paths, into dist-play/ — it needs no API, so it can be hosted
// on any static host (see scripts/inline-play.mjs for a single-file build).
//
// The dev server proxies /api/* to the spider-api server, so the browser makes
// same-origin requests and no CORS config is needed on the API for local dev.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'play' ? './' : '/',
  build:
    mode === 'play'
      ? { outDir: 'dist-play', emptyOutDir: true, rollupOptions: { input: 'play.html' } }
      : { rollupOptions: { input: { main: 'index.html', play: 'play.html' } } },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
}));
