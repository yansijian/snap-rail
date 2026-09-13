/**
 * The renderer spine's bootstrap: acquire the host carrier, build the typed
 * {@link HostLink}, mount the startup page into the handed-over element, and
 * expose both to the caller that later transfers the React root to the plugin
 * runtime — or, when no UI framework face is enabled, to the bootstrap
 * install page (the recovery console).
 *
 * @module @snap-rail/client-kernel
 */

import { HostLink, subscribeFrame, type HostChannel } from '@snap-rail/connection'
import { RENDERER_AUTO_RELOAD_KEY, clientConfigChangedSchema, settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { createRoot, type Root } from 'react-dom/client'
import { BootstrapPage } from './BootstrapPage.tsx'
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
  /** The element the startup page mounted into (runtime re-roots here). */
  element: HTMLElement
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
 * The drag-and-drop bridge: turn a dropped `File` back into its host-side
 * path through the preload's `zipPathOf` (`webUtils.getPathForFile`). Null
 * when the carrier offers no bridge (test hosts, non-Electron shells).
 *
 * @param file - the file object a drop event carried.
 * @returns the absolute path, or `null`.
 */
export function droppedZipPath(file: File): string | null {
  const zipPathOf = (globalThis as { snapRail?: { zipPathOf?: unknown } }).snapRail?.zipPathOf
  if (typeof zipPathOf !== 'function') return null
  const path = (zipPathOf as (candidate: File) => string | null)(file)
  return typeof path === 'string' && path !== '' ? path : null
}

/** Render the startup (connect) page onto the boot root. */
export function showStartup(handle: ClientHandle, options: { onInstall?: () => void } = {}): void {
  handle.root.render(<StartupPage describe={() => handle.link.describeHost()} {...options.onInstall !== undefined ? { onInstall: options.onInstall } : {}} />)
}

/** Render the bootstrap install page (the no-framework recovery console). */
export function showBootstrap(handle: ClientHandle): void {
  handle.root.render(
    <BootstrapPage link={handle.link} zipPathOf={droppedZipPath} onClose={() => showStartup(handle, { onInstall: () => showBootstrap(handle) })} />,
  )
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
  const handle: ClientHandle = { link, root, element: options.element }
  showStartup(handle)
  return handle
}

/** The settings key toggling auto-reload lives with the station contract
 * (`ui.rendererAutoReload`; `false` disables, absent means on). */

/**
 * Reload the window when the plugin rows change, so a toggled occupant or a
 * fresh preset lands without an operator restart — Electron reloads are as
 * cheap as a browser refresh. Enabled by default; the `ui.rendererAutoReload`
 * settings key set to `false` turns it off, hot-applied (no restart to
 * disable the reload, either).
 *
 * @param handle - the boot handle whose link carries the frames and settings.
 * @param options - `debounceMs` coalesces row bursts (default 500).
 * @returns the disposer dropping both subscriptions.
 */
export function installRendererAutoReload(handle: ClientHandle, options: { debounceMs?: number } = {}): () => void {
  const debounceMs = options.debounceMs ?? 500
  let timer: ReturnType<typeof setTimeout> | undefined

  const maybeReload = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => window.location.reload(), debounceMs)
  }

  // The toggle is a plain settings read plus a follower: absent means on,
  // and writes hot-apply so disabling the reload never needs a restart.
  let enabled = true
  void handle.link.call('settings.get', { key: RENDERER_AUTO_RELOAD_KEY }).then(result => {
    if (result.ok) enabled = result.value.value !== false
  })
  const dropSettings = subscribeFrame(handle.link, 'settings/changed', settingsChangedSchema, change => {
    if (change.key !== RENDERER_AUTO_RELOAD_KEY) return
    enabled = change.value !== false
  })
  const dropChanged = subscribeFrame(handle.link, 'client-config/changed', clientConfigChangedSchema, () => {
    if (enabled) maybeReload()
  })
  return () => {
    dropSettings()
    dropChanged()
    if (timer !== undefined) clearTimeout(timer)
  }
}
