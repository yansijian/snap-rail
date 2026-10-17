import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * store-sqlite is host-only (node:sqlite) but happy-dom suites import it to
 * build a real host world. The workspace path mapping resolves it to source,
 * which Vite's client environment refuses to bundle; point the specifier at
 * the built package and mark that path external so Node loads it.
 */
const storeSqliteEntry = fileURLToPath(new URL('./packages/store/store-sqlite/lib/index.js', import.meta.url))

export default defineConfig({
  // Workspace imports resolve through tsconfig.base.json paths (source plane);
  // the base file is the resolution facade and must never gain include/files.
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] })],
  resolve: {
    alias: [{ find: /^@snap-rail\/store-sqlite$/, replacement: storeSqliteEntry }],
  },
  test: {
    // The repo's tests only: `.zcode` holds tooling skills whose own suites
    // are not this repository's tests.
    exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**', '**/.zcode/**', '**/.{idea,git,cache,output,temp}/**'],
    server: {
      deps: {
        // The UI framework moved to its own repository (docs/split-runbook.md);
        // station tests consume its published ESM faces, whose stylesheets
        // (`lib/runtime.js` imports `./ui/theme.css`) node's loader cannot
        // serve — inline the package so vite's css stubbing sees the import.
        inline: [/@snap-rail\/framework-shadcn/],
        external: [/store-sqlite[\\/]lib[\\/]/],
      },
    },
  },
})
