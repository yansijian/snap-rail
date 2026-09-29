import { defineConfig } from 'tsdown'
// The preset imports by source path, not package name: tsdown resolves
// per-package configs' imports against built lib/ output, so a by-name
// import would couple this config to the *previous* build of the kit.
import { clientBundle } from '@snap-rail/plugin-kit/src/build.ts'

/**
 * The framework ships one face per absorbed concern: the renderer runtime
 * (runtime, with the shell inlined), the slot registry, the shared
 * primitives barrel (ui), the settings/session/variables/workflows services,
 * and the fallback layout, plus the root barrel that re-exports them all.
 * The theme stylesheet travels as a source asset (`./theme.css` export).
 *
 * The installable client face (lib-client/client.js) inlines all of those
 * faces into one CJS factory whose default export is the contributed-seed
 * map; the precompiled tailwind output (lib-client/theme.css, built from
 * src/ui/theme.css by the earlier build step) rides the bundle as injected
 * styles — the pool world has no app-level stylesheet.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/\.(png|jpe?g|webp|gif|svg)$/, /\.css$/],
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/runtime.js'] },
  { ...shared, entry: ['lib/types/slots.js'] },
  { ...shared, entry: ['lib/types/semantic.js'] },
  { ...shared, entry: ['lib/types/ui/index.js'] },
  { ...shared, entry: ['lib/types/settings-pages.js'] },
  { ...shared, entry: ['lib/types/session.js'] },
  { ...shared, entry: ['lib/types/variables.js'] },
  { ...shared, entry: ['lib/types/workflows.js'] },
  { ...shared, entry: ['lib/types/fallback.js'] },
  clientBundle('@snap-rail/framework-shadcn', 'src/client.ts', { css: ['lib-client/theme.css'] }),
])
