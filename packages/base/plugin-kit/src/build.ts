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
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'
import { CLIENT_EXTERNALS } from './seeds.ts'

/** Extensions the client preset ships as emitted assets beside the bundle. */
const ASSET_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg)$/

/** The pool directory name an installed package occupies (installer rule). */
function poolDirName(packageName: string): string {
  return packageName.replaceAll('/', '__')
}

/** A cheap stable id for deduplicating injected stylesheet tags. */
function styleId(source: string): string {
  let hash = 5381
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0
  return `snap-rail-css-${(hash >>> 0).toString(36)}`
}

/**
 * Turn `.css` imports into modules that inject a `<style>` tag on first
 * evaluation. The module loader has no stylesheet story and the pool world
 * has no app-level stylesheet: whoever needs tokens or utilities (the
 * framework, above all) carries them inside the bundle, idempotently. The
 * virtual-id redirect (`\0snap-rail-css:`) keeps rolldown's built-in CSS
 * pipeline — which demands `@tsdown/css` and emits side files we have no
 * loader for — out of the graph entirely.
 */
function cssModules(): Plugin {
  const VIRTUAL_PREFIX = '\0snap-rail-css:'
  return {
    name: 'snap-rail-css-modules',
    resolveId(source, importer) {
      if (source.startsWith(VIRTUAL_PREFIX) || !source.endsWith('.css')) return undefined
      const file = isAbsolute(source)
        ? source
        : resolve(dirname(importer ?? process.cwd()), source)
      // The virtual id must not end in `.css` — rolldown classifies modules
      // by extension and would route them into its CSS pipeline.
      return `${VIRTUAL_PREFIX}${file.replaceAll('\\', '/')}.js`
    },
    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return undefined
      const file = id.slice(VIRTUAL_PREFIX.length).replace(/\.js$/, '')
      const css = await readFile(file, 'utf8')
      const tag = styleId(css)
      return [
        `const css = ${JSON.stringify(css)};`,
        `const id = ${JSON.stringify(tag)};`,
        'if (typeof document === "undefined") throw new Error("css module outside the renderer");',
        'if (document.getElementById(id) === null) {',
        '  const style = document.createElement("style");',
        '  style.id = id;',
        '  style.textContent = css;',
        '  document.head.append(style);',
        '}',
        'export default {}',
      ].join('\n')
    },
  }
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

/** Options for {@link clientBundle}. */
export interface ClientBundleOptions {
  /**
   * Stylesheet files to inject into the bundle beyond the `.css` imports the
   * sources make (e.g. a precompiled tailwind output produced by an earlier
   * build step). Each becomes an idempotent style-injection module imported
   * by the entry, so the bundle carries its own styling.
   */
  css?: readonly string[] | undefined
}

/**
 * The client face: a CJS browser bundle welded into the module-loader
 * factory wrapper. Only the seed vocabulary ({@link CLIENT_EXTERNALS} —
 * base plus contributed ids) stays external; everything else (icons,
 * protocol libraries, bitmaps) inlines — bitmaps and SVGs excepted: they
 * emit beside the bundle as `snap-plugin://`-addressed assets instead of
 * base64 bulk, and `.css` imports become style-injection modules.
 *
 * A provider of contributed seeds (a framework, a contract owner) builds
 * the same way: its entry default-exports `{ seeds: { … } }` mapping each
 * subpath to its module namespace, and the shell seeds
 * `<package>/<subpath>` ids from that map after requiring the face.
 *
 * @param packageName - the plugin's npm name (the module id it registers as).
 * @param entry - the renderer entry source file.
 * @param options - see {@link ClientBundleOptions}.
 */
export function clientBundle(packageName: string, entry: string, options: ClientBundleOptions = {}): ReturnType<typeof defineConfig> {
  const entryFile = entry.replaceAll('\\', '/')
  // Extra-css files resolve from the package directory (tsdown runs there).
  const extraCss = (options.css ?? []).map(file => resolve(process.cwd(), file).replaceAll('\\', '/'))
  /** Prepend the extra-css imports to the entry so the styles ride the
   * bundle through the same style-injection modules as source css. */
  const injectExtraCss: Plugin = {
    name: 'snap-rail-inject-extra-css',
    transform(code, id) {
      const file = id.replaceAll('\\', '/').split('?')[0]!.replace(/#.*$/, '')
      if (file !== entryFile || extraCss.length === 0) return undefined
      return `${extraCss.map(css => `import ${JSON.stringify(css)};\n`).join('')}${code}`
    },
  }
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
    // The loader's require only knows the seed table — every third-party
    // dependency (radix, cva, icons, …) inlines into the bundle; tsdown's
    // automatic externalization of package.json dependencies would leave
    // them as unresolvable requires. The explicit `external` list wins.
    noExternal: [/.*/],
    external: [...CLIENT_EXTERNALS],
    plugins: [injectExtraCss, cssModules(), assetUrls(packageName, 'lib-client')],
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
