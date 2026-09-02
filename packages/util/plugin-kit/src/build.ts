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

import { readFile } from 'node:fs/promises'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'
import { SEED_MODULES } from './seeds.ts'

/** Extensions the client preset ships as emitted assets beside the bundle. */
const ASSET_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg)$/

/** The pool directory name an installed package occupies (installer rule). */
function poolDirName(packageName: string): string {
  return packageName.replaceAll('/', '__')
}

/**
 * Emit imported bitmap/svg assets beside the client bundle and rewrite their
 * import values to absolute `snap-plugin://` URLs. The renderer has no
 * filesystem and the module loader's `require` only knows the seed table, so
 * a relative asset path could never resolve at runtime — the transport URL
 * is the one address that works identically in dev and packaged builds.
 * Emitted file names are stable (no content hash — a zip is immutable);
 * same-named assets in different directories collide, last one wins.
 */
function assetUrls(packageName: string, baseDir: string): Plugin {
  return {
    name: 'snap-rail-asset-urls',
    async load(id) {
      const file = id.replaceAll('\\', '/').split('?')[0]!.replace(/#.*$/, '')
      if (!ASSET_EXTENSIONS.test(file)) return undefined
      const fileName = `assets/${file.split('/').at(-1)!}`
      this.emitFile({ type: 'asset', fileName, source: await readFile(file) })
      return `export default ${JSON.stringify(`snap-plugin://pool/${poolDirName(packageName)}/${baseDir}/${fileName}`)}`
    },
  }
}

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
 * else (icons, protocol libraries, bitmaps) inlines — bitmaps and SVGs
 * excepted: they emit beside the bundle as `snap-plugin://`-addressed
 * assets instead of base64 bulk.
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
    // Keep the .js extension: the bundle loads over snap-plugin:// where
    // extension semantics don't apply, and the manifest's client.entry
    // (default `lib/client.js`) names a stable path.
    outExtensions: () => ({ js: '.js' }),
    external: [...SEED_MODULES],
    plugins: [assetUrls(packageName, 'lib-client')],
    outputOptions: {
      // The welded wrapper: the entire bundle body becomes the factory the
      // module loader executes with its own `require` (seeds resolve there).
      // The footer unwraps the interop default — `require(name)` must hand
      // back the plugin object itself, never its CJS namespace envelope.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: function (require, module, exports) {`,
      footer: 'return module.exports && module.exports.__esModule === true && "default" in module.exports ? module.exports.default : module.exports; } });',
    },
  })
}
