import { defineConfig } from 'tsdown'

/**
 * driver-modbus ships three bundles: the host plugin (index — driver plus the
 * nested rpc bridge), the pure renderer-facing contract (contract), and the
 * renderer settings page (station). The entries are JS emitted by tsc under
 * lib/types and are bundled as separate single-entry passes so the
 * renderer-importable entries never carry node-side code from the driver
 * bundle.
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
  { ...shared, entry: ['lib/types/station.js'] },
])
