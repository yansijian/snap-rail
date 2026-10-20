/**
 * Vite config for the marketing website (MPA, no framework).
 *
 * `base: './'` keeps the built dist deployable under any static path —
 * GitHub Pages project sites, OSS buckets and intranet nginx alike —
 * without rewriting asset URLs per host.
 */
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        scenarios: 'scenarios.html',
        plugins: 'plugins.html',
        dev: 'dev.html',
        start: 'start.html',
      },
    },
  },
});
