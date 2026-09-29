import { defineConfig } from 'tsdown'

/**
 * The equipment base ships three node-side faces: index and rpc bundled in
 * ONE multi-entry pass so the two host plugins share a chunk — exactly one
 * copy of every class they pass between them (an inlined duplicate
 * EquipmentError once made every mapped failure surface as bare
 * `internal`) — plus the pure contract subpath consumed by renderer faces.
 * The contract rides the renderer's base seed table (platform surface), so
 * no client face ships.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Bundler asset imports (photos, theme.css) resolve in the renderer
  // bundle, not in node; keep them external instead of failing resolution.
  external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js', 'lib/types/rpc.js'] },
  { ...shared, entry: ['lib/types/contract.js', 'lib/types/driver.js'] },
])
