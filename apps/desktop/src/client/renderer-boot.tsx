/**
 * The renderer's shared boot path, one copy for every surface. A window boots
 * the kernel, seeds the **base** shared-instance table, reads the plugin rows,
 * and hands the root to the installed framework's runtime — or, when no
 * framework face is available, to the kernel's fallback page for that surface.
 *
 * The only thing that differs between surfaces is *which* faces load:
 *
 * - The operator window (`main`) loads each row's main bundle (`clientUrl`).
 * - The auxiliary window (`ball`) loads its own bundle from the row's
 *   `surfaceUrls[surface]` (module id `<package>/<surface>`), plus every
 *   **seed provider** (the framework and other `client.seeds` rows) from its
 *   main bundle — a face needs the framework's primitives and its own CSS
 *   regardless of the window it paints into. Occupant faces without a bundle
 *   for this surface are skipped entirely: a suite's main UI never mounts into
 *   a 128px orb.
 *
 * Auxiliary surfaces never subscribe to equipment points. They render what the
 * host aggregates, so a hidden ball costs no data path and a shown one needs
 * no second subscription graph.
 *
 * @module @snap-rail/desktop/client-renderer-boot
 */

import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import {
  bootClient,
  showBootstrap,
  showBootstrapAfterFailure,
  showSurfaceAfterFailure,
  showSurfaceFallback,
  type ClientHandle,
} from '@snap-rail/client-kernel'
import { installModuleLoader, loadPluginBundle, type ModuleSystem } from '@snap-rail/client-modules'
import * as clientKernel from '@snap-rail/client-kernel'
import * as connection from '@snap-rail/connection'
import * as protocol from '@snap-rail/protocol'
import * as stationRpcContract from '@snap-rail/station-rpc/contract'
import * as appBootContract from '@snap-rail/app-boot/contract'
import * as equipmentContract from '@snap-rail/equipment/contract'
import * as shellContract from '@snap-rail/shell/contract'
import * as snapRailUtil from '@snap-rail/util'
import { checkSeedAbi, SEED_MODULES, type SeedAbi } from '@snap-rail/plugin-kit/seeds'
import * as cordis from '@snap-rail/cordis'
import * as zod from 'zod'
import type { Plugin } from '@snap-rail/cordis'
import type { SurfaceId } from '@snap-rail/protocol'
import type { ClientConfigRow } from '@snap-rail/station-rpc/contract'
import { faceFor, plannedFace } from './surface-faces.ts'

/** What one renderer window needs to boot. */
export interface RendererBootOptions {
  /** The `#root` element of the page. */
  element: HTMLElement
  /** Which surface this window renders. */
  surface: SurfaceId
}

/** The row shape the loader orders and filters by. */
type Row = ClientConfigRow

/** What a loaded face carries: its row, its exports, and whether it is seated here. */
interface LoadedFace {
  name: string
  row: Row
  value: unknown
  /** Whether this face belongs to this surface (the framework face only seats on `main`). */
  seated: boolean
}

/** The runtime face every framework serves from its contributed seeds. */
interface FrameworkRuntimeFace {
  createClientRuntime(
    clientHandle: ClientHandle,
    options: { plugins: readonly (Plugin | { plugin: Plugin, config?: unknown })[], surface?: SurfaceId },
  ): Promise<unknown>
}

/**
 * Seed the base shared-instance table. The table's ids must cover
 * {@link SEED_MODULES} exactly — a drift fails loud at boot, so the shell's
 * instances and the plugin-kit's client-bundle externals can never fall out of
 * step. The contributed tier (framework faces) arrives with installed provider
 * faces instead.
 *
 * @param system - the window's module system.
 */
export async function seedBaseTable(system: ModuleSystem): Promise<void> {
  const table: ReadonlyArray<readonly [id: string, module: unknown]> = [
    ['react', React],
    ['react/jsx-runtime', await import('react/jsx-runtime')],
    ['react-dom', ReactDom],
    ['react-dom/client', ReactDomClient],
    ['@snap-rail/cordis', cordis],
    ['@snap-rail/cordis-plugin-timer', await import('@snap-rail/cordis-plugin-timer')],
    ['@snap-rail/client-kernel', clientKernel],
    ['@snap-rail/client-modules', await import('@snap-rail/client-modules')],
    ['@snap-rail/connection', connection],
    ['@snap-rail/protocol', protocol],
    ['@snap-rail/shell/contract', shellContract],
    ['@snap-rail/station-rpc/contract', stationRpcContract],
    ['@snap-rail/app-boot/contract', appBootContract],
    ['@snap-rail/equipment/contract', equipmentContract],
    ['@snap-rail/util', snapRailUtil],
    ['zod', zod],
  ]
  for (const [id, module] of table) system.seed(id, module)

  const seeded = new Set(table.map(([id]) => id))
  const whitelist = new Set(SEED_MODULES)
  const missing = [...whitelist].filter(id => !seeded.has(id))
  const extra = [...seeded].filter(id => !whitelist.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`client: seed table mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }
}

/** A cordis plugin face (the provider faces export `{ seeds }` instead). */
function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'object' && value !== null
    && typeof (value as Plugin).apply === 'function'
    && typeof (value as { name?: unknown }).name === 'string'
}

/**
 * Load the enabled faces for one surface and hand the root to the framework
 * runtime (or to the surface's fallback). A face whose stamped seed ABI
 * disagrees with the live table is skipped with a loud console error — a drift
 * fails here, on the page, not as a crashed window.
 */
async function runSurfaceRenderer(options: {
  handle: ClientHandle
  system: ModuleSystem
  rows: readonly Row[]
  hostSeedAbi: SeedAbi | undefined
  surface: SurfaceId
}): Promise<void> {
  const { handle, system, rows, hostSeedAbi, surface } = options
  const enabled = rows.filter(row => row.enabled !== false)
  const rank = (row: Row): number =>
    row.kind === 'framework' ? 0 : (row.seeds?.length ?? 0) > 0 ? 1 : 2
  const ordered = [...enabled].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  const faces: LoadedFace[] = []
  for (const row of ordered) {
    const own = faceFor(row, surface)
    const plan = plannedFace(row, surface)
    if (plan === undefined) continue
    if (row.seedAbi !== undefined && hostSeedAbi !== undefined) {
      const verdict = checkSeedAbi(row.seedAbi, hostSeedAbi)
      if (!verdict.ok) {
        console.error(`client: face "${row.name}" refused — ${verdict.reason}`)
        continue
      }
    }
    try {
      await loadPluginBundle(document, plan.url)
      const value = system.require(plan.moduleId)
      // A face seats where it actually renders: on `main` every loaded plugin
      // face seats, on an auxiliary surface only the bundle built for it does.
      const seated = surface === 'main' ? true : own !== undefined
      faces.push({ name: row.name, row, value, seated })
      const seeds = (value as { seeds?: unknown }).seeds
      if (typeof seeds === 'object' && seeds !== null) {
        for (const [key, module] of Object.entries(seeds as Record<string, unknown>)) {
          system.seed(`${row.name}/${key}`, module)
        }
      }
    } catch (cause) {
      console.error(`client: plugin face "${row.name}" failed to load on ${surface}`, cause)
    }
  }

  const frameworkFace = faces.find(face => face.row.kind === 'framework')
  if (frameworkFace === undefined || !system.has(`${frameworkFace.name}/runtime`)) {
    if (frameworkFace !== undefined) {
      console.error(`client: framework face "${frameworkFace.name}" contributes no runtime seed`)
    }
    if (surface === 'main') showBootstrap(handle)
    else showSurfaceFallback(handle)
    return
  }
  const runtime = system.require(`${frameworkFace.name}/runtime`) as FrameworkRuntimeFace

  const seats: Array<Plugin | { plugin: Plugin, config?: unknown }> = []
  for (const face of faces) {
    if (!face.seated || !isPlugin(face.value)) continue
    seats.push(face.row.config === undefined ? face.value : { plugin: face.value, config: face.row.config })
  }
  try {
    await runtime.createClientRuntime(handle, {
      plugins: seats,
      ...surface !== 'main' ? { surface } : {},
    })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.error(`client: the framework runtime failed on ${surface}`, cause)
    if (surface === 'main') {
      showBootstrapAfterFailure(
        handle,
        `插件异常：界面框架启动失败\n${detail}\n\n`
        + '可在下方禁用或卸载出问题的插件后重启；插件管理、搜索与安装不受影响。',
      )
    } else {
      showSurfaceAfterFailure(handle, `插件界面加载失败\n${detail}`)
    }
  }
}

/**
 * Boot one renderer window end to end: kernel, base seeds, rows, faces.
 *
 * @param options - see {@link RendererBootOptions}.
 * @returns the client handle (the caller may add surface-specific behaviour,
 *   e.g. the main window's plugin-row auto-reload).
 */
export async function bootRenderer(options: RendererBootOptions): Promise<ClientHandle> {
  // The module system: installed plugins' client bundles register through the
  // global; the seed table hands them the same instances this bundle uses.
  const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
  const handle = await bootClient({ element: options.element, surface: options.surface })
  const system: ModuleSystem = createSystem()
  await seedBaseTable(system)

  // The rows addressed to renderer occupants carry each one's config, enable
  // flag, bundle URL, and — for pool-installed faces — the URLs of the
  // auxiliary surfaces it ships. `seedAbi` is the host's live seed table:
  // every stamped face handshakes against it before its bundle loads.
  const configResult = await handle.link.call('client-config.list', {})
  const rows = configResult.ok ? configResult.value.rows : []
  const hostSeedAbi: SeedAbi | undefined = configResult.ok ? configResult.value.seedAbi : undefined
  await runSurfaceRenderer({ handle, system, rows, hostSeedAbi, surface: options.surface })
  return handle
}