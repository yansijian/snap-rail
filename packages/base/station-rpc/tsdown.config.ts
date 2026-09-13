import { defineConfig } from 'tsdown'

/**
 * station-rpc ships two entries: the host bridge (index) and the pure
 * renderer-facing contract (contract). The entries are JS emitted by tsc
 * under lib/types and are bundled as separate single-entry passes so the
 * renderer-importable contract never carries host-side code from the
 * bridge bundle.
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
