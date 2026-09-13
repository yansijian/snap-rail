import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The forge package's two outputs: the host face (lib/index.js — the agent
 * loop, generated-plugin runner, and forge RPC domain, ships as the
 * installable zip's host face) and the client face (lib-client/client.js —
 * the workbench pages and the renderer-half runner, the CJS factory bundle
 * the pool-installed renderer loads over snap-plugin://, seeds external).
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
    // fflate rides inside the host bundle (the zip-export packer) — a
    // forge-internal library never joins the anchored shared vocabulary.
    noExternal: ['fflate'],
  },
  clientBundle('@snap-rail/forge', 'src/client/index.tsx'),
])
