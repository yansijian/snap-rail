/**
 * Host boot: compose the two plugin layers, mount the loader tree over the
 * composed entry list, and fail loud with a labelled diagnostic when any part
 * of startup breaks.
 *
 * @module @snap-rail/app-boot/boot
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump } from 'js-yaml'
import { Context } from '@snap-rail/cordis'
import Group from '@snap-rail/cordis-plugin-group'
import Include from '@snap-rail/cordis-plugin-include'
import Loader from '@snap-rail/cordis-plugin-loader'
import { composeEntries, loadBuiltinLayer, loadUserLayer } from './compose.ts'
import { LayerAdmin } from './admin.ts'
import { scanPluginPool } from './scan.ts'

declare module '@snap-rail/cordis' {
  interface Context {
    /** Absolute snap-rail home directory (settings, audit, plugin pool). */
    snapRailHome: string
    /** Runtime layer administration (recompose, user-row edits, watching). */
    pluginLayers: LayerAdmin
  }

  interface Events {
    /** The composed entry list was rewritten and the include refreshed.
     * @param composed - the entry list now mounted. */
    'plugin-layers/applied'(composed: readonly unknown[]): void
  }
}

/** File name of the derived, loader-mounted composition inside the home. */
export const COMPOSED_CONFIG_NAME = '.composed.cordis.yml'

/** Options for {@link boot}. */
export interface BootOptions {
  /** Diagnostic prefix for labelled startup failures. */
  binName: string
  /** Absolute snap-rail home directory; created when missing. */
  home: string
  /** Absolute path of the read-only built-in entry list shipped with the app. */
  builtinLayerPath: string
  /** Absolute path of the user layer (`plugins.yml`); may not exist yet. */
  userLayerPath: string
  /** Directory whose dependency tree resolves built-in plugin names. */
  appRoot: string
  /** Plugin pool directories; defaults to `<home>/plugins`. */
  poolDirs?: readonly string[]
  /** Renderer-occupant package names: their `plugins.yml` rows are config-only
   * (served via `client-config.list`) and never mount into the host tree. */
  rendererPackages?: readonly string[]
  /** Host setup run after the loader mounts and before any config entry. */
  prepare?: (ctx: Context) => void | Promise<void>
}

/** Assert every enabled composed entry ended up with an active fiber. */
function assertEntriesActivated(
  loader: Loader,
  composed: readonly { id: string, disabled?: boolean | null }[],
  binName: string,
  includeId: string,
): void {
  const tree = loader.store[includeId]?.subtree
  for (const entry of composed) {
    if (entry.disabled) continue
    const loaded = tree?.store[entry.id]
    if (loaded?.fiber === undefined) {
      throw new Error(`${binName}: entry ${entry.id} did not activate`)
    }
  }
}

/**
 * Boot the host plugin tree.
 *
 * Writes `<home>/${COMPOSED_CONFIG_NAME}` (a derived artifact — never edit it;
 * edit `plugins.yml` or the built-in layer and reboot or hot-reload), mounts
 * the loader with one root include over it, and returns the settled context.
 *
 * @param options - see {@link BootOptions}.
 * @returns the booted root context.
 * @throws a labelled error (`<binName>: <stage>: <detail>`) after disposing
 * the partial context. Stages: `host preparation failed` (prepare callback),
 * `plugin tree failed to load` (composition or entry activation).
 */
export async function boot(options: BootOptions): Promise<Context> {
  const poolDirs = options.poolDirs ?? [join(options.home, 'plugins')]
  mkdirSync(options.home, { recursive: true })

  const pool = scanPluginPool(poolDirs)
  const builtin = loadBuiltinLayer(options.builtinLayerPath)
  const userLayer = loadUserLayer(options.userLayerPath)
  const rendererPackages = options.rendererPackages ?? []
  const composed = composeEntries({ builtin, userLayer, pool, appRoot: options.appRoot, rendererPackages })
  const composedPath = join(options.home, COMPOSED_CONFIG_NAME)
  writeFileSync(composedPath, dump(composed))

  const ctx = new Context()
  // Two failure labels: `prepare` runs before any config-tree entry mounts,
  // so its failure is host setup, not the plugin tree.
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = `${pathToFileURL(options.home).href}/`
    ctx.provide('snapRailHome', options.home)
    await ctx.plugin(Loader)
    await options.prepare?.(ctx)
    stage = 'plugin tree failed to load'
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    const includeId = await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(composedPath).href },
    })
    const loader = ctx.get('loader')
    // A surface can dispose the tree while startup is in flight; re-read the
    // service after every await instead of dereferencing a dead proxy.
    if (loader === undefined) return ctx
    await loader.await()
    assertEntriesActivated(ctx.loader, composed, options.binName, includeId)
    ctx.provide('pluginLayers', new LayerAdmin(ctx, {
      builtinLayerPath: options.builtinLayerPath,
      userLayerPath: options.userLayerPath,
      appRoot: options.appRoot,
      poolDirs,
      composedPath,
      includeId,
      rendererPackages,
    }))
    return ctx
  } catch (cause) {
    // Root-fiber disposal contains cleanup failures per observer and a
    // repeated call returns the settled single-shot result, so this await
    // cannot reject and replace `cause`.
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${options.binName}: ${stage}: ${detail}`, { cause })
  }
}
