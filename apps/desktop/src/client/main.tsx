/**
 * The renderer entry: install the plugin module loader, bootstrap the
 * kernel, and seed the **base** shared-instance table (react, the spine's
 * client seam — the app ships base only). From there the build splits:
 *
 * - dev (`import.meta.env.DEV`): the static harness in `./dev-harness.tsx`
 *   mounts the framework faces and the shipped occupants from this bundle,
 *   seeding the contributed ids from static imports — the pre-pool flow.
 * - production: the pool path below — `client-config.list` decides what
 *   loads; framework faces come first (they contribute the seeds), other
 *   seed providers next, occupant faces last. With no framework face
 *   enabled, the kernel's bootstrap install page (drag a zip in, enable,
 *   restart) is the terminal's whole interface.
 *
 * @module @snap-rail/desktop/client-main
 */

import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import { bootClient, installRendererAutoReload, showBootstrap, type ClientHandle } from '@snap-rail/client-kernel'
import {
  installModuleLoader,
  loadPluginBundle,
  type ModuleSystem,
} from '@snap-rail/client-modules'
import * as clientKernel from '@snap-rail/client-kernel'
import * as connection from '@snap-rail/connection'
import * as protocol from '@snap-rail/protocol'
import * as stationRpcContract from '@snap-rail/station-rpc/contract'
import * as appBootContract from '@snap-rail/app-boot/contract'
import * as equipmentContract from '@snap-rail/equipment/contract'
import * as snapRailUtil from '@snap-rail/util'
import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import * as cordis from '@snap-rail/cordis'
import * as zod from 'zod'
import type { Plugin } from '@snap-rail/cordis'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

// The module system: installed plugins' client bundles register through the
// global; the seed table hands them the same instances this bundle uses.
const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
const handle = await bootClient({ element })
// Row changes hot-apply host-side; the window reloads so the renderer's
// mounted occupants follow without an operator restart (settings-toggleable).
installRendererAutoReload(handle)
const system: ModuleSystem = createSystem()

// Seed the base shared-instance table. The table's ids must cover
// SEED_MODULES exactly — a drift fails loud at boot right below, so the
// shell's instances and the plugin-kit's client-bundle externals can never
// fall out of step. The contributed tier (framework faces, contracts)
// arrives with installed provider faces instead — see the pool path.
const SEED_TABLE: ReadonlyArray<readonly [id: string, module: unknown]> = [
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
  ['@snap-rail/station-rpc/contract', stationRpcContract],
  ['@snap-rail/app-boot/contract', appBootContract],
  ['@snap-rail/equipment/contract', equipmentContract],
  ['@snap-rail/util', snapRailUtil],
  ['zod', zod],
]
for (const [id, module] of SEED_TABLE) system.seed(id, module)
{
  const seeded = new Set(SEED_TABLE.map(([id]) => id))
  const whitelist = new Set(SEED_MODULES)
  const missing = [...whitelist].filter(id => !seeded.has(id))
  const extra = [...seeded].filter(id => !whitelist.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`client: seed table mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }
}

// The plugins.yml rows addressed to renderer occupants carry each one's
// config, enable flag, and — for pool-installed faces — the bundle URL.
const configResult = await handle.link.call('client-config.list', {})
const rows = configResult.ok ? configResult.value.rows : []

if (import.meta.env.DEV) {
  const harness = await import('./dev-harness.tsx')
  await harness.runDevRenderer({ handle, system, rows })
} else {
  await runPoolRenderer({ handle, system, rows })
}

/** A cordis plugin face (the provider faces export `{ seeds }` instead). */
function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'object' && value !== null
    && typeof (value as Plugin).apply === 'function'
    && typeof (value as { name?: unknown }).name === 'string'
}

/** What a loaded face carries: its row and its required value. */
interface LoadedFace {
  name: string
  row: (typeof rows)[number]
  value: unknown
}

/** The runtime face every framework serves from its contributed seeds. */
interface FrameworkRuntimeFace {
  createClientRuntime(clientHandle: ClientHandle, options: { plugins: readonly (Plugin | { plugin: Plugin, config?: unknown })[] }): Promise<unknown>
}

/**
 * The production renderer: load enabled pool faces in dependency order
 * (framework first, then other seed providers, then occupants), seed every
 * contributed id from the providers, and hand the root to the framework's
 * runtime. Without a framework face, the bootstrap install page takes over.
 */
async function runPoolRenderer(options: {
  handle: ClientHandle
  system: ModuleSystem
  rows: readonly (typeof rows)[number][]
}): Promise<void> {
  const { handle, system, rows } = options
  const enabled = rows.filter(
    (row): row is (typeof rows)[number] & { clientUrl: string } =>
      row.enabled !== false && row.clientUrl !== undefined,
  )
  const rank = (row: (typeof rows)[number]): number =>
    row.kind === 'framework' ? 0 : (row.seeds?.length ?? 0) > 0 ? 1 : 2
  const ordered = [...enabled].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  const faces: LoadedFace[] = []
  for (const row of ordered) {
    try {
      await loadPluginBundle(document, row.clientUrl)
      const value = system.require(row.name)
      faces.push({ name: row.name, row, value })
      const seeds = (value as { seeds?: unknown }).seeds
      if (typeof seeds === 'object' && seeds !== null) {
        for (const [key, module] of Object.entries(seeds as Record<string, unknown>)) {
          system.seed(`${row.name}/${key}`, module)
        }
      }
    } catch (cause) {
      console.error(`client: plugin face "${row.name}" failed to load`, cause)
    }
  }

  const frameworkFace = faces.find(face => face.row.kind === 'framework')
  if (frameworkFace === undefined || !system.has(`${frameworkFace.name}/runtime`)) {
    if (frameworkFace !== undefined) {
      console.error(`client: framework face "${frameworkFace.name}" contributes no runtime seed`)
    }
    showBootstrap(handle)
    return
  }
  const runtime = system.require(`${frameworkFace.name}/runtime`) as FrameworkRuntimeFace

  const seats: Array<Plugin | { plugin: Plugin, config?: unknown }> = []
  for (const face of faces) {
    if (!isPlugin(face.value)) continue
    seats.push(face.row.config === undefined ? face.value : { plugin: face.value, config: face.row.config })
  }
  await runtime.createClientRuntime(handle, { plugins: seats })
}
