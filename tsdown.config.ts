import { defineConfig } from 'tsdown'

/**
 * The workspace build consumes JavaScript emitted by the host TypeScript
 * project (`tsc -b tsconfig.host.json` writes lib/types) and bundles each
 * package's runtime entries into lib/. Per-package tsdown configs (the
 * vendored schemastery/logger-console dual-output overrides) are picked up
 * automatically in workspace mode.
 */
export default defineConfig({
  workspace: ['vendor/*', 'packages/*/*'],
  entry: ['lib/types/{index,rpc,contract,scan}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Bundler asset imports (plugin-bundled photos, the UI seam's theme.css):
  // the node-side lib never loads them — only the renderer bundle does,
  // through Vite. Keep the imports untouched instead of failing resolution.
  external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
})
