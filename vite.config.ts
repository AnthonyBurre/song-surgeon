import { defineConfig } from 'vite';

// On GitHub Pages a project site is served from /<repo>/, so the production
// build needs that base path. Dev server stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/song-surgeon/' : '/',
  worker: { format: 'es' },
}));
