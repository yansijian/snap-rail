/**
 * The built-in renderer runtime: it takes over the kernel root, mounts the
 * core services, the skins, the layout/page plugins, and finally the fallback
 * layout. There is no framework row and no framework seed: the substrate is
 * always present, so a fresh install has a usable UI before any plugin is
 * installed.
 *
 * @module @snap-rail/ui/runtime
 */

import type { ClientHandle } from '@snap-rail/client-kernel'
import { subscribeFrame, type HostLink } from '@snap-rail/connection'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { Context, type Plugin } from '@snap-rail/cordis'
import { TimerService as timerPlugin } from '@snap-rail/cordis-plugin-timer'
import type { SurfaceId } from '@snap-rail/protocol'
import { shellContract } from '@snap-rail/shell/contract'
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import fallbackPlugin from './fallback.tsx'
import pagesPlugin from './pages.tsx'
import type { SettingsPageDefinition } from './settings.tsx'
import settingsPlugin from './settings.tsx'
import { UI_SLOT_IDS, type LayoutContribution } from './contract.ts'
import { Slot, UiProvider, useActiveLayout, useUiVersion } from './slots.tsx'
import slotsPlugin from './slots.tsx'
import { SkinsProvider } from './skins.tsx'
import skinsPlugin from './skins.tsx'

/** The shared services every occupant may consume. */
export interface ClientServices {
  /** The typed host link shared by every occupant. */
  link: HostLink
  /** Which window this client tree serves. */
  surface: SurfaceId
}

declare module '@snap-rail/cordis' {
  interface Context {
    client: ClientServices
  }
}

/** The React context carrying the host link/surface into builtin pages. */
const ClientContext = createContext<ClientServices | null>(null)

/** Provide the client services to builtin page components. */
export function ClientProvider(props: { service: ClientServices; children: ReactNode }): ReactNode {
  return <ClientContext.Provider value={props.service}>{props.children}</ClientContext.Provider>
}

/** Read the client services (host link + surface) from a builtin page. */
export function useClient(): ClientServices {
  const service = useContext(ClientContext)
  if (service === null) throw new Error('useClient: no ClientProvider in the tree')
  return service
}

/** One occupant seat. */
export interface OccupantSpec {
  plugin: Plugin
  config?: unknown
}

/** Options for {@link createClientRuntime}. */
export interface RuntimeOptions {
  /** Layout/page/feature plugins, already ordered by the boot loader. */
  plugins: readonly (Plugin | OccupantSpec)[]
  /** The window this runtime serves; defaults to `main`. */
  surface?: SurfaceId
  /** Core settings pages registered by the app (equipment, about, ...). */
  builtinPages?: readonly SettingsPageDefinition[]
}

/** The runtime handle. */
export interface RuntimeHandle {
  ctx: Context
  dispose(): Promise<void>
}

/** Re-render on settings open/page changes. */
function useSettingsVersion(ctx: Context): number {
  return useSyncExternalStore(ctx.settings.subscribe, ctx.settings.version, ctx.settings.version)
}

/** Apply the active layout's stage profiles to the host. */
function StageProfiles(props: { ctx: Context; layout: LayoutContribution | undefined }): null {
  const link = props.ctx.client.link
  const layout = props.layout
  useEffect(() => {
    if (layout?.window !== undefined) {
      void link.call('shell.window.configure', { profile: layout.window }).catch(() => {})
    }
    if (layout?.ball !== undefined) {
      void link.call('shell.ball.configure', { profile: layout.ball }).catch(() => {})
    }
  }, [layout?.id])
  return null
}

/** The global overlay host: registry-owned surfaces do not depend on a layout. */
function OverlayHost(props: { ctx: Context }): ReactNode {
  useUiVersion(props.ctx.ui)
  useSettingsVersion(props.ctx)
  const overlays = props.ctx.ui.list(UI_SLOT_IDS.overlay)
  const settingsOpen = props.ctx.settings.isOpen()
  const settingsSurfaces = settingsOpen ? props.ctx.ui.list(UI_SLOT_IDS.settingsSurface) : []
  const pages = props.ctx.settings.listPages().map(page => ({
    id: page.id,
    title: page.title,
    ...page.group !== undefined ? { group: page.group } : {},
    order: page.order,
  }))
  const context = {
    pages,
    ...props.ctx.settings.activePage() !== undefined ? { activeId: props.ctx.settings.activePage() } : {},
    close: () => props.ctx.settings.close(),
  }
  return (
    <>
      {overlays.map(item => <span key={item.id}>{item.render({ surface: 'main' })}</span>)}
      {settingsSurfaces.map(item => <span key={item.id}>{item.render(context)}</span>)}
    </>
  )
}

/** The floating settings fallback, rendered only when no layout provides the seat. */
function SettingsFallbackHost(props: { ctx: Context }): ReactNode {
  useUiVersion(props.ctx.ui)
  useSettingsVersion(props.ctx)
  if (props.ctx.ui.hasProvider(UI_SLOT_IDS.settingsEntry)) return null
  const entry = props.ctx.ui.list(UI_SLOT_IDS.settingsEntry)[0]
  if (entry === undefined) return null
  return (
    <div
      data-snap-part="settings.fallback"
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 'var(--snap-z-overlay)' }}
    >
      {entry.render({
        presentation: 'icon',
        open: () => props.ctx.settings.open(),
        isOpen: props.ctx.settings.isOpen(),
      })}
    </div>
  )
}

/** The operator-window root. */
function MainRoot(props: { ctx: Context }): ReactNode {
  const layout = useActiveLayout()
  return (
    <>
      <StageProfiles ctx={props.ctx} layout={layout} />
      {layout === undefined ? <div style={{ padding: 24 }}>没有已加载的布局插件。</div> : layout.render()}
      <OverlayHost ctx={props.ctx} />
      <SettingsFallbackHost ctx={props.ctx} />
    </>
  )
}

/** The fallback ball face used when no plugin occupies `shell.ball`. */
function BallRoot(props: { ctx: Context }): ReactNode {
  useUiVersion(props.ctx.ui)
  const occupant = props.ctx.ui.list(UI_SLOT_IDS.ball)[0]
  if (occupant !== undefined) {
    return <div style={{ width: '100%', height: '100%' }}>{occupant.render({ surface: 'ball' })}</div>
  }
  return (
    <div
      data-snap-part="ball.root"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        color: 'var(--snap-color-muted)',
        fontSize: 'var(--snap-text-xs)',
      }}
    >
      snap-rail
    </div>
  )
}

/** The root that mounts the layout (or the ball face) and the global overlays. */
function UiRoot(props: { ctx: Context; surface: SurfaceId }): ReactNode {
  return (
    <ClientProvider service={props.ctx.client}>
      <UiProvider service={props.ctx.ui}>
        <SkinsProvider service={props.ctx.skins}>
          {props.surface === 'main' ? <MainRoot ctx={props.ctx} /> : <BallRoot ctx={props.ctx} />}
        </SkinsProvider>
      </UiProvider>
    </ClientProvider>
  )
}

/**
 * Take over the kernel root and mount the UI substrate.
 *
 * @param handle - the kernel boot result.
 * @param options - see {@link RuntimeOptions}.
 */
export async function createClientRuntime(handle: ClientHandle, options: RuntimeOptions): Promise<RuntimeHandle> {
  const surface = options.surface ?? 'main'
  const ctx = new Context()
  ctx.provide('client', { link: handle.link, surface })

  await ctx.plugin(timerPlugin)
  await ctx.plugin(slotsPlugin)
  await ctx.plugin(pagesPlugin)
  await ctx.plugin(skinsPlugin)
  await ctx.plugin(settingsPlugin)

  // The operator's theme row is a simple settings.json value; apply it to the
  // skin service now and follow the settings/changed frame without a reload.
  const applyThemeRow = (value: unknown): void => {
    const mode = (value as { mode?: unknown } | null)?.mode
    const choice = mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'dark'
    const prefersLight = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: light)').matches
    const resolved = choice === 'system' ? (prefersLight ? 'light' : 'dark') : choice
    ctx.skins.setMode(resolved)
    if (typeof document !== 'undefined') document.documentElement.dataset['mode'] = resolved
  }
  void handle.link.call('settings.get', { key: 'ui.theme' })
    .then(result => { if (result.ok) applyThemeRow(result.value.value) })
    .catch(() => {})
  const dropTheme = subscribeFrame(handle.link, 'settings/changed', settingsChangedSchema, change => {
    if (change.key === 'ui.theme') applyThemeRow(change.value)
  })
  const dropOpenSettings = subscribeFrame(
    handle.link,
    'shell/settings-open-requested',
    shellContract.frames['shell/settings-open-requested'],
    () => { ctx.settings.open() },
  )
  ctx.effect(() => () => {
    dropTheme()
    dropOpenSettings()
  })

  // Core settings pages ride the same registry as plugin pages; the app owns
  // the equipment page component and hands it in here.
  for (const page of options.builtinPages ?? []) ctx.settings.registerPage(ctx, page)

  for (const seat of options.plugins) {
    const spec: OccupantSpec = 'plugin' in seat ? seat : { plugin: seat }
    const plugin = spec.plugin as Plugin<Record<string, unknown>>
    await ctx.plugin(plugin, spec.config === undefined ? {} : spec.config as Record<string, unknown>)
  }

  // The fallback is a normal low-precedence layout occupant; a suite layout
  // shadows it and its disposal brings the fallback back.
  if (surface === 'main') await ctx.plugin(fallbackPlugin)

  handle.root.unmount()
  const shellRoot = createRoot(handle.element)
  shellRoot.render(<UiRoot ctx={ctx} surface={surface} />)

  return {
    ctx,
    dispose: () => ctx.fiber.dispose().then(() => {
      shellRoot.unmount()
    }),
  }
}

/** The built-in fallback layout plugin (exported for tests and custom hosts). */
export { fallbackPlugin }
export { pagesPlugin, settingsPlugin, slotsPlugin, skinsPlugin }
export { Slot }