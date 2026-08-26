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
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
