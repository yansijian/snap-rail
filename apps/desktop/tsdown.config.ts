import { defineConfig } from 'tsdown'

/**
 * Desktop host faces: the ESM main process entry and the sandbox-safe CJS
 * preload bundle (Electron sandboxes require a CommonJS preload).
 */
export default defineConfig([
  {
    entry: { 'main/index': 'lib/types/main/index.js' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    // Electron reads the plain-JS main path from package.json.
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    clean: false,
  },
  {
    entry: { 'preload/index': 'lib/types/preload/index.js' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
  },
])
