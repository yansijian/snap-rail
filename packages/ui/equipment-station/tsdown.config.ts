import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The unified 设备管理 page ships two outputs: the workspace renderer entry
 * (lib/index.js — Vite-bundled into dist/client for the dev harness's
 * static path) and the installable client face (lib-client/client.js — the
 * CJS factory bundle the pool-installed renderer loads over
 * snap-plugin://, seeds external). The package is clientOnly: no host face
 * exists or ships.
 */
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
  },
  clientBundle('@snap-rail/equipment-station', 'src/index.tsx'),
])
