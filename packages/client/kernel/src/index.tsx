/**
 * The renderer spine's bootstrap: acquire the host carrier, build the typed
 * {@link HostLink}, mount the startup page into the handed-over element, and
 * expose both to the caller that later transfers the React root to the plugin
 * runtime.
 *
 * @module @snap-rail/client-kernel
 */

import { HostLink, type HostChannel } from '@snap-rail/connection'
import { createRoot, type Root } from 'react-dom/client'
import { StartupPage } from './StartupPage.tsx'

export type { HostChannel }

/** Options for {@link bootClient}. */
export interface ClientBootOptions {
  /** Element the startup page mounts into (the index.html root div). */
  element: HTMLElement
  /** Carrier override; defaults to the preload-exposed `window.snapRail`. */
  channel?: HostChannel
}

/** Everything bootstrap produced, for the runtime handover and diagnostics. */
export interface ClientHandle {
  /** The typed client over the host carrier. */
  link: HostLink
  /** The live React root; the client runtime takes it over on arrival. */
  root: Root
}

/** Narrow the preload-global to the carrier contract; missing shapes fail loud. */
function windowChannel(): HostChannel {
  const candidate = (globalThis as { snapRail?: unknown }).snapRail
  const invoke = (candidate as { invoke?: unknown } | undefined)?.invoke
  const openStream = (candidate as { openStream?: unknown } | undefined)?.openStream
  if (typeof invoke !== 'function' || typeof openStream !== 'function') {
    throw new Error('client-kernel: window.snapRail does not provide invoke/openStream; preload failed to run')
  }
  return candidate as HostChannel
}

/**
 * Bootstrap the renderer: open the typed host link and render the startup
 * page immediately; the page settles through the host handshake on its own.
 *
 * @param options - see {@link ClientBootOptions}.
 * @returns the client handle (link plus live React root).
 */
export async function bootClient(options: ClientBootOptions): Promise<ClientHandle> {
  const link = new HostLink(options.channel ?? windowChannel())
  const root = createRoot(options.element)
  root.render(<StartupPage describe={() => link.describeHost()} />)
  return { link, root }
}
