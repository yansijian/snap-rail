import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The trend package's two outputs (the forge shape — trend is a pure pool
 * plugin, installed from its zip): the host face (lib/index.js — the
 * change-point recorder, binding evaluator, probability engine, and trend
 * RPC domain, ships as the installable zip's host face) and the client face
 * (lib-client/client.js — the settings page as a CJS factory bundle a
 * pool-installed copy loads over snap-plugin://, seeds external).
 */
export default defineConfig([
  {
    entry: {
      index: 'lib/types/index.js',
      contract: 'lib/types/contract.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
  },
  clientBundle('@snap-rail/trend', 'src/client/index.tsx'),
])
