/**
 * The fallback shell (兜底壳): the built-in minimal layout that shows when
 * no business suite is active — a bare titlebar (window controls + the
 * settings entry, so a fresh install can always reach the plugin manager)
 * and an empty state pointing there. It yields the moment a suite layout
 * registers: it renders only while it is the sole full-screen layout
 * occupant (the settings dialog's own occupant is a portal, not a layout).
 *
 * @module @snap-rail/client-fallback
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/client-settings'
import '@snap-rail/client-slots'
import { Button, useRefresh } from '@snap-rail/client-ui'
import type { HostLink } from '@snap-rail/connection'
import { Fragment, type ReactNode } from 'react'

/**
 * The renderer's host-link service (declared by client-runtime; reached via
 * `ctx.get` to keep the project graph acyclic — see field/station's note).
 */
interface ClientLinkService {
  link: HostLink
}

/** The settings dialog's occupant id (a Dialog portal, not a layout). */
const SETTINGS_OCCUPANT_ID = 'settings-dialog'

/** Window-control glyphs; inline so the shell needs no icon dependency. */
function ControlIcons(props: { onMinimize: () => void, onToggleMaximize: () => void, onClose: () => void }): ReactNode {
  const base = 'flex h-10 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
  return (
    <div className="flex items-center">
      <button type="button" aria-label="最小化" className={base} onClick={props.onMinimize}>
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <button type="button" aria-label="最大化" className={base} onClick={props.onToggleMaximize}>
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none"><rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button type="button" aria-label="关闭" className={`${base} hover:bg-destructive hover:text-white`} onClick={props.onClose}>
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none"><path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
    </div>
  )
}

/** The fallback body: minimal titlebar + install guidance. */
function FallbackShell(props: { ctx: Context, link: HostLink }): ReactNode {
  useRefresh(props.ctx, ['ui/slot-changed', 'settings/open-changed'])
  const layouts = props.ctx.uiSlots.list('layout')
  const fullScreen = layouts.filter(occupant => occupant.id !== SETTINGS_OCCUPANT_ID)
  // A suite layout took over: render nothing.
  if (fullScreen.length > 1) return null
  const windowControl = (action: 'minimize' | 'toggle-maximize' | 'close'): void => {
    void props.link.call('window.control', { action }).catch(() => undefined)
  }
  return (
    <div className="flex h-full flex-col" data-region="fallback-shell">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-4 select-none" style={{ WebkitAppRegion: 'drag' } as never}>
        <span className="text-sm text-muted-foreground">snap-rail</span>
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as never}>
          {/* Occupant-contributed icon buttons (e.g. forge's AI 创造 entry)
           * stay reachable even with no suite active. */}
          {props.ctx.uiSlots.list('titlebar-actions').map(occupant => (
            <Fragment key={occupant.id}>{occupant.render()}</Fragment>
          ))}
          <button
            type="button"
            aria-label="设置"
            className="flex h-10 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => props.ctx.settingsPages.open()}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
            </svg>
          </button>
          <ControlIcons onMinimize={() => windowControl('minimize')} onToggleMaximize={() => windowControl('toggle-maximize')} onClose={() => windowControl('close')} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="grid max-w-md gap-4 text-center">
          <div className="text-xl font-medium text-foreground">尚未激活业务套件</div>
          <p className="text-sm text-muted-foreground">
            打开设置的「插件管理」页，安装并激活一个业务套件；通讯驱动也在同一处安装。
          </p>
          <div>
            <Button data-fallback-open-settings onClick={() => props.ctx.settingsPages.open()}>打开设置</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The fallback shell occupant. */
const fallbackShellPlugin: Plugin.Object<void> = {
  name: 'client-fallback',
  inject: ['uiSlots', 'settingsPages'],
  apply(ctx: Context): void {
    const client = ctx.get('client') as ClientLinkService
    ctx.uiSlots.register(ctx, 'layout', {
      id: 'fallback-shell',
      order: 200,
      render(): ReactNode {
        return <FallbackShell ctx={ctx} link={client.link} />
      },
    })
  },
}

export default fallbackShellPlugin
