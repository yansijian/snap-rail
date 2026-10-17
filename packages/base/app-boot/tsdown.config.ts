import { defineConfig } from 'tsdown'

/**
 * app-boot ships six single-entry passes: the composer (index), the admin
 * bridge (rpc — combo archive reading is bundled into it), the pure
 * renderer-facing contract (contract), the plugin-pool scanner (scan) that
 * station-rpc's loader entry imports, the seed-ABI table resolver
 * (seed-abi) the installer and station-rpc share, and the sidecars
 * (invariant, trust). The entries are JS emitted by tsc under lib/types and
 * are bundled separately so the renderer-importable contract never carries
 * host-side code from the bridge bundles.
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
  { ...shared, entry: ['lib/types/rpc.js'] },
  { ...shared, entry: ['lib/types/contract.js'] },
  { ...shared, entry: ['lib/types/scan.js'] },
  { ...shared, entry: ['lib/types/seed-abi.js'] },
  { ...shared, entry: ['lib/types/invariant.js'] },
  { ...shared, entry: ['lib/types/trust.js'] },
])
