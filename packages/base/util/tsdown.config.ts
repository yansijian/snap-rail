import { defineConfig } from 'tsdown'

/**
 * util ships two runtime entries: the barrel (index) and the semver module
 * (`./semver` subpath export — the one comparator every version check in
 * snap-rail reads). The tsc staging tree provides lib/types.
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
])
