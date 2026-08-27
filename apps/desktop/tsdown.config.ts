import { defineConfig } from 'tsdown'

/**
 * Desktop host faces: the ESM main process entry and the sandbox-safe CJS
 * preload bundle (Electron sandboxes require a CommonJS preload). `electron`
 * must stay external — bundling the npm wrapper pulls its CJS entry (and
 * `__dirname`) into ESM scope and breaks at load.
 */
export default defineConfig([
  {
    entry: { 'main/index': 'lib/types/main/index.js' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    deps: { neverBundle: ['electron'] },
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
    deps: { neverBundle: ['electron'] },
    dts: false,
    clean: false,
  },
])
