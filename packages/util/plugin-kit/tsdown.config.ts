import { defineConfig } from 'tsdown'

/**
 * The kit's public surface splits across four entries: the umbrella index,
 * the manifest vocabulary (manifest), the renderer seed whitelist (seeds),
 * and the tsdown presets (build) plugin authors import when bundling
 * installable zips. Entries are the JS tsc emits under lib/types.
 */
export default defineConfig({
  entry: ['lib/types/{index,manifest,seeds,build}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
