import { defineConfig } from 'tsdown'

/**
 * The trend tool ships two faces: the host counter (index — the shift
 * accumulator over the store seam) and the pure contract (shift schemas and
 * snapshot types the production page and future tools consume). The
 * contract rides the renderer's base seed table (platform surface), so no
 * client face ships.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/contract.js'] },
  { ...shared, entry: ['lib/types/invariant.js'] },
])
