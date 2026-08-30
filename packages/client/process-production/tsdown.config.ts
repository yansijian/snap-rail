import { defineConfig } from 'tsdown'

/**
 * process-production ships two entries: the renderer page (index — consumed
 * by the client build, never by the host tree) and the host-side shift
 * counter (stats — the loader row mounts it in the host tree). The entries
 * are JS emitted by tsc under lib/types and are bundled as separate
 * single-entry passes so the renderer bundle never carries host-side code
 * from the counter and vice versa.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Bundler asset imports ride only in the renderer bundle (Vite); the
  // node-side lib never loads them — keep the imports untouched instead of
  // failing resolution (same hardening as the workspace-root config).
  external: [/\.(png|jpe?g|webp|gif|svg)$/],
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/stats.js'] },
])
