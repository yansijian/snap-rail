import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  // Workspace imports resolve through tsconfig.base.json paths (source plane);
  // the base file is the resolution facade and must never gain include/files.
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] })],
})
