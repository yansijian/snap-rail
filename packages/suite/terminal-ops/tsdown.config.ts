import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The suite's two outputs: the workspace renderer entry (lib/index.js —
 * Vite-bundled into dist/client for the dev harness's static path) and the
 * installable client face (lib-client/client.js — the CJS factory bundle
 * the pool-installed renderer loads over snap-plugin://, seeds external).
 * The package is clientOnly: the host-side shift counter lives in
 * @snap-rail/trend since the trend extraction; no host face ships.
 */
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
  },
  clientBundle('@snap-rail/suite-terminal-ops', 'src/index.tsx'),
])
