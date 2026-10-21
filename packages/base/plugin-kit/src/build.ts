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

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'
import { CLIENT_EXTERNALS } from './seeds.ts'

/**
 * Contributed-seed ids this package declares it requires from other plugins
 * (`snapRail.client.externalSeeds`), read from the package.json in the
 * working directory (tsdown runs there). clientBundle externalizes exactly
 * these ids on top of the seed whitelist, so a consumer's bundle resolves a
 * third-party framework's primitives or an extension pack's components from
 * the runtime seed table — single instances — instead of inlining private
 * copies the loader could never resolve.
 */
function declaredExternalSeeds(): readonly string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      snapRail?: { client?: { externalSeeds?: string[] } }
    }
    const seeds = manifest.snapRail?.client?.externalSeeds
    return Array.isArray(seeds) && seeds.every(seed => typeof seed === 'string' && seed !== '') ? seeds : []
  } catch {
    return []
  }
}

/** Extensions the client preset ships as emitted assets beside the bundle. */
const ASSET_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg)$/

/**
 * The seed interop guard: a client face must consume seed modules through
 * **named or star imports only**. A default import compiles — under
 * rolldown's CJS node-mode interop (`__toESM(require(id), 1)`) — into
 * `.default` = the required namespace itself, never the module's own
 * default export. A class-shaped seed (the timer service) then arrives as
 * a plain object and cordis refuses it at mount: on the user's terminal,
 * as a dead renderer, instead of here at build time. Star and named
 * imports survive both interop modes; `import type` erases and is fine.
 *
 * Source-level scan (emit-independent), plugin sources only — inlined
 * third-party dependencies keep their own import style.
 */
export function seedImportGuard(): Plugin {
  const seedPattern = CLIENT_EXTERNALS
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('|')
  const pattern = new RegExp(
    String.raw`import\s+(?![{*])(?!type\b)([\w$]+)\s*(?:,[^;]*?)?\s*from\s*['"](` + seedPattern + String.raw`)['"]`,
  )
  return {
    name: 'snap-rail-seed-import-guard',
    transform(code, id) {
      if (id.includes('node_modules')) return undefined
      const match = pattern.exec(code)
      if (match === null) return undefined
      this.error(
        `种子模块 "${match[2]}" 被默认导入（import ${match[1]} from '${match[2]}'）。`
        + '种子只允许 named/star 导入：rolldown 的 CJS interop 会把 default 变成整个命名空间对象，'
        + '运行时挂载即崩。请改为 import { … } from \'' + match[2] + '\' 或 import * as ns from \'' + match[2] + '\'。',
      )
    },
  }
}

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
    // Keep the plain `.js` extension: the manifest `main` the packer stamps
    // (and every generated template writes) names `lib-host/host.js` — tsdown's
    // default esm renaming would emit `host.mjs` and pack would then refuse
    // to ship a zip whose entry file does not exist.
    fixedExtension: false,
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
  /**
   * The emitted file's base name inside `lib-client` (default `client`, so
   * the file is `lib-client/client.js`). Auxiliary surfaces build one bundle
   * per window and name them after the surface (`ball`, `panel`); the
   * manifest's `client.surfaces` points at those files.
   */
  outName?: string | undefined
  /**
   * The module id the bundle registers under (default: the package name).
   * A package's **main** surface registers as the package itself, so
   * `createClientRuntime` can require it by row name; an auxiliary surface
   * registers as `<package>/<surface>` — one package, several windows, no
   * two bundles fighting over one id.
   */
  moduleId?: string | undefined
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
 * A package that renders in more than one window calls this once per surface:
 * the main surface keeps the package name as its module id and `client` as its
 * file name, while an auxiliary surface passes `outName` and `moduleId` so its
 * bundle lands beside the main one (`lib-client/ball.js`) and registers as
 * `<package>/ball` — the id that surface's window requires.
 *
 * @param packageName - the plugin's npm name (asset URLs and the default module id).
 * @param entry - the renderer entry source file.
 * @param options - see {@link ClientBundleOptions}.
 */
export function clientBundle(packageName: string, entry: string, options: ClientBundleOptions = {}): ReturnType<typeof defineConfig> {
  const entryFile = entry.replaceAll('\\', '/')
  // The transform hook ids are resolved absolute paths — compare against
  // the absolute entry (a relative `entry` never equals one, which used to
  // silently disable the whole extra-css injection). Normalized to forward
  // slashes like every id below.
  const entryPath = resolve(process.cwd(), entryFile).replaceAll('\\', '/')
  // Extra-css files resolve from the package directory (tsdown runs there).
  const extraCss = (options.css ?? []).map(file => resolve(process.cwd(), file).replaceAll('\\', '/'))
  /** Prepend the extra-css imports to the entry so the styles ride the
   * bundle through the same style-injection modules as source css. */
  const injectExtraCss: Plugin = {
    name: 'snap-rail-inject-extra-css',
    transform(code, id) {
      const file = id.replaceAll('\\', '/').split('?')[0]!.replace(/#.*$/, '')
      if (file !== entryPath || extraCss.length === 0) return undefined
      return `${extraCss.map(css => `import ${JSON.stringify(css)};\n`).join('')}${code}`
    },
  }
  return defineConfig({
    entry: { [options.outName ?? 'client']: entry },
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
    // them as unresolvable requires. The explicit `external` list wins:
    // the seed whitelist plus this package's declared externalSeeds.
    noExternal: [/.*/],
    external: [...CLIENT_EXTERNALS, ...declaredExternalSeeds()],
    plugins: [injectExtraCss, cssModules(), assetUrls(packageName, 'lib-client'), seedImportGuard()],
    outputOptions: {
      // The welded wrapper: the entire bundle body becomes the factory the
      // module loader executes with its own `require` (seeds resolve there).
      // The footer unwraps the interop default — `require(name)` must hand
      // back the plugin object itself, never its CJS namespace envelope.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.moduleId ?? packageName)}, factory: function (require, module, exports) {`,
      footer: 'return module.exports && module.exports.__esModule === true && "default" in module.exports ? module.exports.default : module.exports; } });',
    },
  })
}
