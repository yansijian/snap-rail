import { defineConfig } from 'tsdown'

/**
 * The built-in equipment page is a normal ESM client library imported by the
 * desktop app bundle. It is no longer an installable clientOnly plugin, so it
 * ships no `lib-client` factory face.
 */
export default defineConfig({
  entry: { page: 'lib/types/page.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/\.css$/],
})