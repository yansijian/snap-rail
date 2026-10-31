/**
 * Vite config for the marketing website (MPA, no framework).
 *
 * `base: './'` keeps the built dist deployable under any static path —
 * GitHub Pages project sites, OSS buckets and intranet nginx alike —
 * without rewriting asset URLs per host.
 *
 * The product version is injected at build time from the desktop app
 * manifest (`apps/desktop/package.json` — the same field electron-builder
 * packages), so ld+json version shapes can never drift from releases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const APP_MANIFEST = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(APP_MANIFEST, 'utf-8')).version;

/** `__SNAP_RAIL_VERSION__` in index.html ld+json → the packaged app version. */
function snapRailVersion() {
  return {
    name: 'snap-rail-version',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) => html.replaceAll('__SNAP_RAIL_VERSION__', APP_VERSION),
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [tailwindcss(), snapRailVersion()],
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
