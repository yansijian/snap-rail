/**
 * The renderer entry: bootstrap the kernel, pull the renderer-occupant rows
 * carved out of the shared `plugins.yml` (`client-config.list`), then hand
 * the React root to the client runtime with this build's occupant list —
 * station layout, chrome, and the five process pages. The boot-graph-driven
 * loader replaces the in-app list when plugins ship as directories.
 *
 * @module @snap-rail/desktop/client-main
 */

import titlebarPlugin from '@snap-rail/chrome-titlebar'
import { bootClient } from '@snap-rail/client-kernel'
import downtimePlugin from '@snap-rail/process-downtime'
import faultPlugin from '@snap-rail/process-fault'
import maintenancePlugin from '@snap-rail/process-maintenance'
import productionPlugin from '@snap-rail/process-production'
import samplingPlugin from '@snap-rail/process-sampling'
import settingsStationPlugin from '@snap-rail/settings-station'
import modbusStationPlugin from '@snap-rail/driver-modbus/station'
import layoutPlugin from '@snap-rail/layout-station'
import { createClientRuntime, type OccupantSpec } from '@snap-rail/client-runtime'
import type { Plugin } from '@snap-rail/cordis'
import { RENDERER_PACKAGES } from '../../src-host/main/renderer-packages.ts'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

const handle = await bootClient({ element })

// The plugins.yml rows addressed to renderer occupants carry each one's
// config (sampling cron, production model table) and optional enabled flag;
// absent rows mean defaults and enabled.
const configResult = await handle.link.call('client-config.list', {})
const rows = configResult.ok
  ? new Map(configResult.value.rows.map(row => [row.name, row]))
  : new Map<string, { enabled: boolean, config?: unknown }>()

const OCCUPANTS: ReadonlyArray<{ name: string, plugin: Plugin }> = [
  { name: '@snap-rail/layout-station', plugin: layoutPlugin },
  { name: '@snap-rail/chrome-titlebar', plugin: titlebarPlugin },
  { name: '@snap-rail/process-maintenance', plugin: maintenancePlugin },
  { name: '@snap-rail/process-production', plugin: productionPlugin },
  { name: '@snap-rail/process-sampling', plugin: samplingPlugin },
  { name: '@snap-rail/process-fault', plugin: faultPlugin },
  { name: '@snap-rail/process-downtime', plugin: downtimePlugin },
  { name: '@snap-rail/settings-station', plugin: settingsStationPlugin },
  { name: '@snap-rail/driver-modbus/station', plugin: modbusStationPlugin },
]

// The pairing must cover the shipped manifest exactly — a drifted list
// (a name here but not in the manifest, or vice versa) fails loud at boot
// instead of silently dropping a page or its config row.
{
  const paired = new Set(OCCUPANTS.map(seat => seat.name))
  const missing = RENDERER_PACKAGES.filter(name => !paired.has(name))
  const extra = [...paired].filter(name => !RENDERER_PACKAGES.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`client: renderer manifest mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }
}

const seats: (Plugin | OccupantSpec)[] = []
for (const seat of OCCUPANTS) {
  const row = rows.get(seat.name)
  if (row?.enabled === false) continue
  seats.push(row?.config === undefined ? seat.plugin : { plugin: seat.plugin, config: row.config })
}

await createClientRuntime(handle, { plugins: seats })
