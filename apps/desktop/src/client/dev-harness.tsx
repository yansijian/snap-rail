/**
 * The dev-only static harness: when Vite serves the app
 * (`import.meta.env.DEV`), the framework's faces and the three shipped
 * occupants mount from this bundle instead of the plugin pool — the
 * contributed-seed ids are seeded from static imports (sourceOf keeps every
 * consumer on the same module instances), pool-installed faces shadow the
 * shipped occupants of the same name, and the occupant pairing keeps its
 * fail-loud parity check against RENDERER_PACKAGES. The production bundle
 * never includes this module — the pool path in `main.tsx` replaces it
 * wholesale.
 *
 * @module @snap-rail/desktop/client-dev-harness
 */

import type { Plugin } from '@snap-rail/cordis'
import { createClientRuntime, type OccupantSpec } from '@snap-rail/framework-shadcn/runtime'
import type { ModuleSystem } from '@snap-rail/client-modules'
import { loadPluginBundle } from '@snap-rail/client-modules'
import type { ClientHandle } from '@snap-rail/client-kernel'
import type { ClientConfigRow } from '@snap-rail/station-rpc/contract'
import settingsStationPlugin from '@snap-rail/settings-station'
import equipmentStationPlugin from '@snap-rail/equipment-station'
import suitePlugin from '@snap-rail/suite-terminal-ops'
import * as clientFallback from '@snap-rail/framework-shadcn/fallback'
import * as clientRuntime from '@snap-rail/framework-shadcn/runtime'
import * as clientSession from '@snap-rail/framework-shadcn/session'
import * as clientSettings from '@snap-rail/framework-shadcn/settings-pages'
import * as clientSlots from '@snap-rail/framework-shadcn/slots'
import * as clientSemantic from '@snap-rail/framework-shadcn/semantic'
import * as clientUi from '@snap-rail/framework-shadcn/ui'
import * as clientVariables from '@snap-rail/framework-shadcn/variables'
import * as clientWorkflows from '@snap-rail/framework-shadcn/workflows'
import { RENDERER_PACKAGES } from '../../src-host/main/renderer-packages.ts'

/** Everything the harness needs from the boot in main.tsx. */
export interface DevHarnessOptions {
  handle: ClientHandle
  system: ModuleSystem
  rows: readonly ClientConfigRow[]
}

/**
 * Run the dev renderer: seed the contributed ids from static imports, load
 * pool-installed faces, mount the shipped occupants (shadowed by pool faces
 * of the same name), and hand the root to the client runtime.
 */
export async function runDevRenderer(options: DevHarnessOptions): Promise<void> {
  const { handle, system, rows } = options

  // The contributed-seed tier, dev flavor: the framework's faces, seeded
  // here from the app bundle's own instances (the wire contracts ride the
  // base tier in main.tsx — they are platform surface, not framework).
  const CONTRIBUTED_TABLE: ReadonlyArray<readonly [id: string, module: unknown]> = [
    ['@snap-rail/framework-shadcn/ui', clientUi],
    ['@snap-rail/framework-shadcn/slots', clientSlots],
    ['@snap-rail/framework-shadcn/semantic', clientSemantic],
    ['@snap-rail/framework-shadcn/settings-pages', clientSettings],
    ['@snap-rail/framework-shadcn/session', clientSession],
    ['@snap-rail/framework-shadcn/workflows', clientWorkflows],
    ['@snap-rail/framework-shadcn/variables', clientVariables],
    ['@snap-rail/framework-shadcn/runtime', clientRuntime],
    ['@snap-rail/framework-shadcn/fallback', clientFallback],
  ]
  for (const [id, module] of CONTRIBUTED_TABLE) system.seed(id, module)

  // Pool-installed client faces: fetch each bundle (the wrapper registers
  // through the global) and require the value back.
  const installed: Array<{ name: string, plugin: Plugin }> = []
  for (const row of rows) {
    if (row.enabled === false || row.clientUrl === undefined) continue
    try {
      await loadPluginBundle(document, row.clientUrl)
      const value = system.require(row.name) as Plugin | { seeds: Record<string, unknown> }
      if (isPlugin(value)) installed.push({ name: row.name, plugin: value })
    } catch (cause) {
      console.error(`client: plugin face "${row.name}" failed to load`, cause)
    }
  }

  // This build's shipped occupants — the pairing must cover the shipped
  // manifest exactly (a drifted list fails loud at boot).
  const OCCUPANTS: ReadonlyArray<{ name: string, plugin: Plugin }> = [
    { name: '@snap-rail/suite-terminal-ops', plugin: suitePlugin },
    { name: '@snap-rail/settings-station', plugin: settingsStationPlugin },
    { name: '@snap-rail/equipment-station', plugin: equipmentStationPlugin },
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
    const row = rows.find(candidate => candidate.name === seat.name)
    if (row?.enabled === false) continue
    seats.push(row?.config === undefined ? seat.plugin : { plugin: seat.plugin, config: row.config })
  }

  await createClientRuntime(handle, { plugins: seats })
}

/** A cordis plugin face (the provider faces export `{ seeds }` instead). */
function isPlugin(value: unknown): value is Plugin {
  return typeof value === 'object' && value !== null
    && typeof (value as Plugin).apply === 'function'
    && typeof (value as { name?: unknown }).name === 'string'
}
