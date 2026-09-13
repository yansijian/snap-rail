import { defineConfig } from 'tsdown'

/**
 * The enip driver ships two faces: the host adapter (index) and the pure
 * dialect subpath (contract). The wire codec is driver-local source — no
 * third-party protocol library rides along — so nothing needs inlining.
 * Entries are the JS tsc emits under lib/types.
 */

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/contract.js'] },
])
