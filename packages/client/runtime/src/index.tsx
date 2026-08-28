/**
 * The client renderer host: takes over the React root from the kernel,
 * mounts the phase-1 occupant plugins into one client Cordis context, and
 * renders the slot-driven shell that re-renders whenever any occupied slot
 * changes. When no layout plugin registered, the shell degrades to a notice
 * instead of an empty window.
 *
 * @module @snap-rail/client-runtime
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import type { ClientHandle } from '@snap-rail/client-kernel'
import type { HostLink } from '@snap-rail/connection'
import slotsPlugin from '@snap-rail/client-slots'
import sessionPlugin from '@snap-rail/client-session'
import workflowsPlugin from '@snap-rail/client-workflows'
import { createRoot } from 'react-dom/client'
import { Shell } from './Shell.tsx'
// The single theme import: tokens and base styles ship with whoever links
// the runtime; Tailwind scans the sources the theme.css @source list names.
import '@snap-rail/client-ui/theme.css'

declare module '@snap-rail/cordis' {
  interface Context {
    /** Shared client-side services every occupant may consume. */
    client: ClientServices
  }
}

/** Services mounted once for all occupant plugins. */
export interface ClientServices {
  /** The typed host link shared by every occupant. */
  link: HostLink
}

/** One occupant seat: the plugin plus the config carved from its plugins.yml row. */
export interface OccupantSpec {
  /** The occupant plugin (layout, chrome, process pages). */
  plugin: Plugin
  /** The occupant's config when its user-layer row carries one. */
  config?: unknown
}

/** Options for {@link createClientRuntime}. */
export interface RuntimeOptions {
  /**
   * Occupant plugins (layout, chrome, process pages) — a bare plugin or one
   * paired with config. Phase 1 ships them from an in-app list; the
   * boot-graph-driven loader replaces this seat when plugin directories ship
   * outside the bundle.
   */
  plugins: readonly (Plugin | OccupantSpec)[]
}

export interface RuntimeHandle {
  ctx: Context
  dispose(): Promise<void>
}

/**
 * Take over the booted root: stop the startup page, mount the client plugin
 * tree, render the shell.
 *
 * @param handle - the kernel's boot result.
 * @param options - see {@link RuntimeOptions}.
 */
export async function createClientRuntime(handle: ClientHandle, options: RuntimeOptions): Promise<RuntimeHandle> {
  const ctx = new Context()
  ctx.provide('client', { link: handle.link })
  // Spine services first: timer gives occupants disposable intervals, slots
  // carries the panel seam, session and workflows sit under every occupant.
  await ctx.plugin(timerPlugin)
  await ctx.plugin(slotsPlugin)
  await ctx.plugin(sessionPlugin)
  await ctx.plugin(workflowsPlugin)
  for (const seat of options.plugins) {
    const spec: OccupantSpec = 'plugin' in seat ? seat : { plugin: seat }
    // Plugins without a Config ignore the second argument; an empty object
    // lets zod-defaulted configs (model tables, schedules) fill themselves.
    const plugin = spec.plugin as Plugin<Record<string, unknown>>
    await ctx.plugin(plugin, spec.config === undefined ? {} : spec.config as Record<string, unknown>)
  }

  // Take over the element: the startup root unmounts, a fresh shell roots.
  handle.root.unmount()
  const shellRoot = createRoot(handle.element)
  shellRoot.render(<Shell ctx={ctx} />)

  return {
    ctx,
    dispose: () => ctx.fiber.dispose().then(() => {
      shellRoot.unmount()
    }),
  }
}
