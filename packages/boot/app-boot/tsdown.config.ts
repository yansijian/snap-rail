import { defineConfig } from 'tsdown'

/**
 * app-boot ships three entries: the composer (index), the admin bridge
 * (rpc), and the pure renderer-facing contract (contract). The entries are
 * JS emitted by tsc under lib/types and are bundled as separate
 * single-entry passes so the renderer-importable contract never carries
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
])
