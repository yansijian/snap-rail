import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The suite's two faces in one package:
 *
 * - host (`src/stats.ts` → `lib/stats.js`, the `./stats` subpath and npm
 *   main): the durable shift counter — settings seam + store tables +
 *   `production/stats-changed` frames. tsc compiles it to
 *   `lib/types/stats.js`; this config re-bundles that node-side output.
 * - renderer (`src/index.tsx` → `lib-client/client.js`): the installable
 *   CJS factory bundle the pool-installed renderer loads over
 *   snap-plugin://, seeds external. The dev harness mounts the renderer
 *   from source (vite sourceOf) and the host from the built `./stats`.
 */
export default defineConfig([
  {
    entry: { stats: 'lib/types/stats.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
  },
  clientBundle('@snap-rail/suite-terminal-ops', 'src/index.tsx'),
])
