import { defineConfig } from 'tsdown'

/**
 * Bootstrap runtime build paired with `tsconfig.bootstrap.json`: bundles the
 * base/store/equipment packages the split plugin repos consume, without the
 * UI layer (equipment-station imports the framework and would form a cycle).
 * The full `tsdown.config.ts` runs later, after the framework face exists.
 */
export default defineConfig({
  workspace: ['vendor/*', 'packages/base/*', 'packages/store/*', 'packages/equipment/*'],
  entry: ['lib/types/{index,rpc,contract,scan,manifest}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
})
