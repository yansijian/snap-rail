import { defineConfig } from 'tsdown'

/**
 * util ships three runtime entries: the barrel (index), the semver module
 * (`./semver` subpath export — the one comparator every version check in
 * snap-rail reads), and the layer vocabulary (`./manifest`, imported by
 * plugin-kit's manifest schema). The tsc staging tree provides lib/types.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { semver: 'lib/types/semver.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { manifest: 'lib/types/manifest.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
