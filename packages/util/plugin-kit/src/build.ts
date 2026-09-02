/**
 * tsdown config factories for plugin packages — the two faces a plugin
 * ships. The host face is a plain ESM node bundle; the client face is the
 ** CJS factory bundle** the renderer's module loader consumes: the whole
 * output wrapped in `window.__ModuleLoader__.load({ id, factory })`, with
 * the seed table externalized (shared instances, zero duplication).
 *
 * Usage (a plugin package's `tsdown.config.ts`):
 *
 * ```ts
 * import { clientBundle, hostBundle } from '@snap-rail/plugin-kit/build'
 * export default [
 *   hostBundle('packages/host/src/index.ts'),
 *   clientBundle('@scope/my-suite', 'packages/client/src/index.tsx'),
 * ]
 * ```
 *
 * @module @snap-rail/plugin-kit/build
 */

import { defineConfig } from 'tsdown'
import { SEED_MODULES } from './seeds.ts'

/**
 * The host face: an ESM node bundle. The spine stays external by default
 * (tsdown externalizes package.json dependencies); anything else the plugin
 * needs ships inside.
 *
 * @param entry - the host entry source file.
 */
export function hostBundle(entry: string): ReturnType<typeof defineConfig> {
  return defineConfig({
    entry: { host: entry },
    outDir: 'lib-host',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
  })
}

/**
 * The client face: a CJS browser bundle welded into the module-loader
 * factory wrapper. Only {@link SEED_MODULES} stay external; everything
 * else (including CSS-in-JS and icons) inlines.
 *
 * @param packageName - the plugin's npm name (the module id it registers as).
 * @param entry - the renderer entry source file.
 */
export function clientBundle(packageName: string, entry: string): ReturnType<typeof defineConfig> {
  return defineConfig({
    entry: { client: entry },
    outDir: 'lib-client',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    external: [...SEED_MODULES],
    outputOptions: {
      // The welded wrapper: the entire bundle body becomes the factory the
      // module loader executes with its own `require` (seeds resolve there).
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: function (require, module, exports) {`,
      footer: 'return module.exports; } });',
    },
  })
}
