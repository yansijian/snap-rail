/**
 * The renderer entry: install the plugin module loader, bootstrap the
 * kernel, seed the shared-instance table (react, the spine's client seam),
 * pull the renderer-occupant rows carved out of the shared `plugins.yml`
 * (`client-config.list`), load pool-installed client faces over
 * `snap-plugin://`, then hand the React root to the client runtime —
 * the terminal-ops suite, the settings dialog shell, and the field base's
 * unified 设备管理 page from this build; everything else from the pool.
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
import * as cordis from '@snap-rail/cordis'
import * as zod from 'zod'
import type { Plugin } from '@snap-rail/cordis'
import { RENDERER_PACKAGES } from '../../src-host/main/renderer-packages.ts'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

// The module system: installed plugins' client bundles register through the
// global; the seed table hands them the same instances this bundle uses.
const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
const handle = await bootClient({ element })
const system: ModuleSystem = createSystem()

// Seed the shared-instance table — the ids match SEED_MODULES exactly.
system.seed('react', React)
system.seed('react/jsx-runtime', await import('react/jsx-runtime'))
system.seed('react-dom', ReactDom)
system.seed('react-dom/client', ReactDomClient)
system.seed('@snap-rail/cordis', cordis)
system.seed('@snap-rail/client-ui', clientUi)
system.seed('@snap-rail/client-kernel', clientKernel)
system.seed('@snap-rail/client-slots', clientSlots)
system.seed('@snap-rail/client-settings', clientSettings)
system.seed('@snap-rail/client-session', clientSession)
system.seed('@snap-rail/client-workflows', clientWorkflows)
system.seed('@snap-rail/client-variables', clientVariables)
system.seed('@snap-rail/client-modules', await import('@snap-rail/client-modules'))
system.seed('@snap-rail/connection', connection)
system.seed('@snap-rail/protocol', protocol)
system.seed('@snap-rail/station-rpc/contract', stationRpcContract)
system.seed('@snap-rail/app-boot/contract', appBootContract)
system.seed('zod', zod)

// The plugins.yml rows addressed to renderer occupants carry each one's
// config, enable flag, and — for pool-installed faces — the bundle URL.
const configResult = await handle.link.call('client-config.list', {})
const rows = configResult.ok
  ? new Map(configResult.value.rows.map(row => [row.name, row]))
  : new Map<string, { enabled: boolean, config?: unknown, clientUrl?: string }>()

// Pool-installed client faces: fetch each bundle (the wrapper registers
// through the global) and require the plugin object back.
const installed: Array<{ name: string, plugin: Plugin }> = []
for (const [name, row] of rows) {
  if (row.enabled === false || row.clientUrl === undefined) continue
  try {
    await loadPluginBundle(document, row.clientUrl)
    const plugin = system.require(name) as Plugin
    installed.push({ name, plugin })
  } catch (cause) {
    console.error(`client: plugin face "${name}" failed to load`, cause)
  }
}

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

const seats: (Plugin | OccupantSpec)[] = []
for (const seat of [...OCCUPANTS, ...installed]) {
  const row = rows.get(seat.name)
  if (row?.enabled === false) continue
  seats.push(row?.config === undefined ? seat.plugin : { plugin: seat.plugin, config: row.config })
}

await createClientRuntime(handle, { plugins: seats })
