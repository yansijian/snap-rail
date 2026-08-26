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
import type { ClientHandle } from '@snap-rail/client-kernel'
import type { HostLink } from '@snap-rail/connection'
import slotsPlugin from '@snap-rail/client-slots'
import { createRoot } from 'react-dom/client'
import { Shell } from './Shell.tsx'
import { THEME_CSS } from './theme.ts'
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

/** Options for {@link createClientRuntime}. */
export interface RuntimeOptions {
  /**
   * Occupant plugins (layout, chrome, panels). Phase 1 ships them from an
   * in-app list; the boot-graph-driven loader replaces this seat when plugin
   * directories ship outside the bundle.
   */
  plugins: readonly Plugin[]
}

export interface RuntimeHandle {
  ctx: Context
  dispose(): Promise<void>
}

/**
 * Take over the booted root: stop the startup page, mount the client plugin
 * tree, render the slot-driven shell.
 *
 * @param handle - the kernel's boot result.
 * @param options - see {@link RuntimeOptions}.
 */
export async function createClientRuntime(handle: ClientHandle, options: RuntimeOptions): Promise<RuntimeHandle> {
  installTheme()
  const ctx = new Context()
  await ctx.plugin(slotsPlugin)
  for (const plugin of options.plugins) {
    await ctx.plugin(plugin as Plugin<void>)
  }
  ctx.provide('client', { link: handle.link })

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

/** Inject the design-token stylesheet once per document. */
function installTheme(): void {
  if (document.getElementById('snap-rail-theme') !== null) return
  const style = document.createElement('style')
  style.id = 'snap-rail-theme'
  style.textContent = THEME_CSS
  document.head.append(style)
}
