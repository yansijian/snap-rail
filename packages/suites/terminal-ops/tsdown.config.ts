import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The suite's three outputs: the workspace renderer entry (lib/index.js,
 * Vite-bundled into dist/client for the shipped static path), the host-side
 * shift counter (lib/stats.js, ships in the host tree and as the installable
 * zip's host face), and the installable client face (lib-client/client.js —
 * the CJS factory bundle the pool-installed renderer loads over
 * snap-plugin://, seeds external).
 */
export default defineConfig([
  {
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
  },
  clientBundle('@snap-rail/suite-terminal-ops', 'src/index.tsx'),
])
