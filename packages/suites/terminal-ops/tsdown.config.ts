import { defineConfig } from 'tsdown'

/**
 * The suite's two faces build separately: the renderer entry (lib/index.js,
 * Vite-bundled into dist/client) and the host-side shift counter
 * (lib/stats.js, ships in the host tree).
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    stats: 'lib/types/stats.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
})
