import { defineConfig } from 'vite';

// Relative asset paths, so the same build works on GitHub Pages (served from
// /<repo>/) and from the local engine server (served from /).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // In dev, forward API calls to a running engine server (`npm run engine`),
  // so the page and the API share an origin just as they do in production.
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
});
