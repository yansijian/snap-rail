/**
 * The renderer entry: install the plugin module loader, bootstrap the
 * kernel, seed the shared-instance table (react, the spine's client seam),
 * pull the renderer-occupant rows carved out of the shared `plugins.yml`
 * (`client-config.list`), load pool-installed client faces over
 * `snap-plugin://`, then hand the React root to the client runtime —
 * the terminal-ops suite, the settings dialog shell, and the field base's
 * unified 设备管理 page from this build; everything else from the pool.
 *
 * The same entry serves the AI 创造 studio window (`?window=forge`): that
 * page loads only the forge face — its layout occupant is the whole window —
 * and skips the shipped occupants and their manifest parity check entirely.
 *
 * @module @snap-rail/desktop/client-main
 */

import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import { bootClient } from '@snap-rail/client-kernel'
import settingsStationPlugin from '@snap-rail/settings-station'
import fieldStationPlugin from '@snap-rail/field/station'
import fallbackShellPlugin from '@snap-rail/client-fallback'
import suitePlugin from '@snap-rail/suite-terminal-ops'
import { createClientRuntime, type OccupantSpec } from '@snap-rail/client-runtime'
import {
  installModuleLoader,
  loadPluginBundle,
  type ModuleSystem,
} from '@snap-rail/client-modules'
import * as clientUi from '@snap-rail/client-ui'
import * as clientKernel from '@snap-rail/client-kernel'
import * as clientSlots from '@snap-rail/client-slots'
import * as clientSettings from '@snap-rail/client-settings'
import * as clientSession from '@snap-rail/client-session'
import * as clientWorkflows from '@snap-rail/client-workflows'
import * as clientVariables from '@snap-rail/client-variables'
import * as connection from '@snap-rail/connection'
import * as protocol from '@snap-rail/protocol'
import * as stationRpcContract from '@snap-rail/station-rpc/contract'
import * as appBootContract from '@snap-rail/app-boot/contract'
import * as fieldContract from '@snap-rail/field/contract'
import * as snapRailUtil from '@snap-rail/util'
import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import * as cordis from '@snap-rail/cordis'
import * as zod from 'zod'
import type { Plugin } from '@snap-rail/cordis'
import { RENDERER_PACKAGES } from '../../src-host/main/renderer-packages.ts'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

// The studio window branch: same entry, different occupant set (below).
const studioWindow = new URLSearchParams(window.location.search).get('window') === 'forge'

// The module system: installed plugins' client bundles register through the
// global; the seed table hands them the same instances this bundle uses.
const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
const handle = await bootClient({ element })
const system: ModuleSystem = createSystem()

// Seed the shared-instance table. The table's ids must cover SEED_MODULES
// exactly — a drift fails loud at boot right below, so the shell's instances
// and the plugin-kit's client-bundle externals can never fall out of step.
const SEED_TABLE: ReadonlyArray<readonly [id: string, module: unknown]> = [
  ['react', React],
  ['react/jsx-runtime', await import('react/jsx-runtime')],
  ['react-dom', ReactDom],
  ['react-dom/client', ReactDomClient],
  ['@snap-rail/cordis', cordis],
  ['@snap-rail/cordis-plugin-timer', await import('@snap-rail/cordis-plugin-timer')],
  ['@snap-rail/client-ui', clientUi],
  ['@snap-rail/client-kernel', clientKernel],
  ['@snap-rail/client-slots', clientSlots],
  ['@snap-rail/client-settings', clientSettings],
  ['@snap-rail/client-session', clientSession],
  ['@snap-rail/client-workflows', clientWorkflows],
  ['@snap-rail/client-variables', clientVariables],
  ['@snap-rail/client-modules', await import('@snap-rail/client-modules')],
  ['@snap-rail/connection', connection],
  ['@snap-rail/protocol', protocol],
  ['@snap-rail/station-rpc/contract', stationRpcContract],
  ['@snap-rail/app-boot/contract', appBootContract],
  ['@snap-rail/field/contract', fieldContract],
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
const rows = configResult.ok
  ? new Map(configResult.value.rows.map(row => [row.name, row]))
  : new Map<string, { enabled: boolean, config?: unknown, clientUrl?: string }>()

// Pool-installed client faces: fetch each bundle (the wrapper registers
// through the global) and require the plugin object back. The studio window
// loads only the forge face — other faces' registrations target the main
// window's chrome and must not run twice.
const installed: Array<{ name: string, plugin: Plugin }> = []
for (const [name, row] of rows) {
  if (row.enabled === false || row.clientUrl === undefined) continue
  if (studioWindow && name !== '@snap-rail/forge') continue
  try {
    await loadPluginBundle(document, row.clientUrl)
    const plugin = system.require(name) as Plugin
    installed.push({ name, plugin })
  } catch (cause) {
    console.error(`client: plugin face "${name}" failed to load`, cause)
  }
}

if (studioWindow) {
  // The studio window mounts just the forge face; its layout occupant is
  // the entire window (titlebar included), so no shipped occupants apply.
  const seats: (Plugin | OccupantSpec)[] = []
  for (const seat of installed) {
    const row = rows.get(seat.name)
    seats.push(row?.config === undefined ? seat.plugin : { plugin: seat.plugin, config: row.config })
  }
  await createClientRuntime(handle, { plugins: seats })
} else {
  // This build's shipped occupants — the pairing must cover the shipped
  // manifest exactly (a drifted list fails loud at boot).
  const OCCUPANTS: ReadonlyArray<{ name: string, plugin: Plugin }> = [
    { name: '@snap-rail/suite-terminal-ops', plugin: suitePlugin },
    { name: '@snap-rail/settings-station', plugin: settingsStationPlugin },
    { name: '@snap-rail/field/station', plugin: fieldStationPlugin },
    { name: '@snap-rail/client-fallback', plugin: fallbackShellPlugin },
  ]
  {
    const paired = new Set(OCCUPANTS.map(seat => seat.name))
    const missing = RENDERER_PACKAGES.filter(name => !paired.has(name))
    const extra = [...paired].filter(name => !RENDERER_PACKAGES.includes(name))
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`client: renderer manifest mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
    }
  }

  // Pool-installed faces shadow the shipped occupant of the same name — the
  // host compose side resolves the same way (pool rows win), so both ends
  // mount exactly one instance per package.
  const seats: (Plugin | OccupantSpec)[] = []
  const mounted = new Set<string>()
  for (const seat of [...installed, ...OCCUPANTS]) {
    if (mounted.has(seat.name)) continue
    mounted.add(seat.name)
    const row = rows.get(seat.name)
    if (row?.enabled === false) continue
    seats.push(row?.config === undefined ? seat.plugin : { plugin: seat.plugin, config: row.config })
  }

  await createClientRuntime(handle, { plugins: seats })
}
