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
import { isAuxSurfaceId } from '@snap-rail/protocol'
import type { AuxSurfaceId, SurfaceId } from '@snap-rail/protocol'
import { RENDERER_AUTO_RELOAD_KEY, clientConfigChangedSchema, settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { pluginDiagnosticsSchema, type PluginDiagnostics } from '@snap-rail/app-boot/contract'
import { createRoot, type Root } from 'react-dom/client'
import { BootstrapPage } from './BootstrapPage.tsx'
import { StartupPage } from './StartupPage.tsx'
import { SurfaceFallback } from './SurfaceFallback.tsx'

export type { HostChannel }
export { SurfaceFallback }

/** Options for {@link bootClient}. */
export interface ClientBootOptions {
  /** Element the startup page mounts into (the index.html root div). */
  element: HTMLElement
  /** Carrier override; defaults to the preload-exposed `window.snapRail`. */
  channel?: HostChannel
  /**
   * Which surface this window renders; defaults to `main`. An auxiliary
   * surface boots headless — no connect page, no operator UI — because its
   * window is created on demand and must never flash a full-page screen
   * inside a 128px orb. Whoever loads the surface decides what to mount next
   * (the framework runtime, or {@link showSurfaceFallback}).
   */
  surface?: SurfaceId
}

/** Everything bootstrap produced, for the runtime handover and diagnostics. */
export interface ClientHandle {
  /** The typed client over the host carrier. */
  link: HostLink
  /** The live React root; the client runtime takes it over on arrival. */
  root: Root
  /** The element the startup page mounted into (runtime re-roots here). */
  element: HTMLElement
  /** Which surface this window renders — the renderer half of the Shell's
   * window roles (`main`, `ball`, `panel`). */
  surface: SurfaceId
}

async function describeDiagnostics(link: HostLink): Promise<PluginDiagnostics> {
  const result = await link.call('plugins.diagnostics', {})
  if (!result.ok) throw new Error(`plugin diagnostics failed: ${result.error.code}`)
  return pluginDiagnosticsSchema.parse(result.value.snapshot)
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
  handle.root.render(<StartupPage describe={() => handle.link.describeHost()} diagnose={() => describeDiagnostics(handle.link)} {...options.onInstall !== undefined ? { onInstall: options.onInstall } : {}} />)
}

/** Render the bootstrap install page (the no-framework recovery console). */
export function showBootstrap(handle: ClientHandle, options: { notice?: string } = {}): void {
  handle.root.render(
    <BootstrapPage
      link={handle.link}
      zipPathOf={droppedZipPath}
      {...options.notice !== undefined ? { notice: options.notice } : {}}
      onClose={() => showStartup(handle, { onInstall: () => showBootstrap(handle) })}
    />,
  )
}

/**
 * Release whatever root state remains and re-root a fresh React tree on the
 * boot element. A framework that failed mid-takeover may have unmounted the
 * boot root or wedged it; the fresh root is the authority either way.
 */
function remountRoot(handle: ClientHandle): void {
  try {
    handle.root.unmount()
  } catch {
    // The framework may have unmounted the boot root before failing — the
    // fresh root below is the authority either way.
  }
  handle.root = createRoot(handle.element)
}

/**
 * The crash fallback: the framework's runtime failed after taking the boot
 * root over. Bring the recovery console up with the failure surfaced on the
 * page — the operator keeps plugin management instead of a dead splash.
 */
export function showBootstrapAfterFailure(handle: ClientHandle, notice: string): void {
  remountRoot(handle)
  showBootstrap(handle, { notice })
}

/**
 * The auxiliary-surface fallback: the ball and panel windows always render
 * something usable, even with no framework installed (a draggable orb that
 * summons the operator window, a panel that explains what is missing). On the
 * main surface this is the bootstrap page — the recovery console already is
 * that surface's fallback.
 *
 * @param handle - the surface's boot handle.
 * @param options - `notice` surfaces a failure on the fallback (red strip, red dot).
 */
export function showSurfaceFallback(handle: ClientHandle, options: { notice?: string } = {}): void {
  if (!isAuxSurfaceId(handle.surface)) {
    showBootstrap(handle, options)
    return
  }
  const surface: AuxSurfaceId = handle.surface
  handle.root.render(
    <SurfaceFallback
      link={handle.link}
      surface={surface}
      {...options.notice !== undefined ? { notice: options.notice } : {}}
    />,
  )
}

/** {@link showSurfaceFallback} after a runtime failure — the auxiliary twin of
 * {@link showBootstrapAfterFailure}. */
export function showSurfaceAfterFailure(handle: ClientHandle, notice: string): void {
  remountRoot(handle)
  showSurfaceFallback(handle, { notice })
}

/**
 * Bootstrap the renderer: open the typed host link and render the startup
 * page immediately; the page settles through the host handshake on its own.
 * An auxiliary surface boots bare — its caller mounts the framework runtime
 * or {@link showSurfaceFallback} as soon as the rows are known.
 *
 * @param options - see {@link ClientBootOptions}.
 * @returns the client handle (link, live React root, and the surface it serves).
 */
export async function bootClient(options: ClientBootOptions): Promise<ClientHandle> {
  const link = new HostLink(options.channel ?? windowChannel())
  const root = createRoot(options.element)
  const surface = options.surface ?? 'main'
  const handle: ClientHandle = { link, root, element: options.element, surface }
  if (surface === 'main') showStartup(handle)
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
