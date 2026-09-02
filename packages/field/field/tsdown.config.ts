import { defineConfig } from 'tsdown'

/**
 * The field base ships four faces: the node-side base (index), the
 * plugins-domain wire (rpc), the pure contract subpath consumed by
 * renderer faces (contract), and the renderer-facing 设备管理 page
 * (station). The entries are JS emitted by tsc under lib/types and are
 * bundled as separate single-entry passes so the renderer-importable page
 * never carries the node side (store/drizzle) from the host bundles.
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
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/rpc.js'] },
  { ...shared, entry: ['lib/types/contract.js'] },
  { ...shared, entry: ['lib/types/station.js'] },
])
