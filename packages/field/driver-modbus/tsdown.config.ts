import { defineConfig } from 'tsdown'

/**
 * driver-modbus ships three entries: the driver plugin (index), the loader
 * entry for the host bridge (rpc), and the pure renderer-facing contract
 * (contract). The entries are JS emitted by tsc under lib/types and are
 * bundled as separate single-entry passes so the renderer-importable
 * contract never carries node-side code from the driver bundles.
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
