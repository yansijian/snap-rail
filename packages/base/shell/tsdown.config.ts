import { defineConfig } from 'tsdown'

/**
 * The shell seam ships two entries: the host-side service definition (index)
 * and the pure renderer-facing contract (contract). Separate single-entry
 * passes keep the two planes apart — a client face importing the contract
 * must never drag the service definition into the renderer graph.
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