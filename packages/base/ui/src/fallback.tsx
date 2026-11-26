/**
 * The built-in fallback layout: a minimal titlebar, a settings seat, window
 * controls, and an empty state pointing at the plugin manager. It is an
 * ordinary low-precedence layout occupant, not a special shell branch; a
 * suite layout with higher precedence replaces it and its disposal brings the
 * fallback back automatically.
 *
 * It renders **every** slot it declares: `shell.titlebar` and
 * `shell.titlebar.actions` in the window bar, `shell.sidebar` and
 * `shell.statusbar` in the shell frame once something contributes to them,
 * `settings.entry` next to the window controls. A slot declared but never
 * rendered would swallow contributions without a trace, so the two lists stay
 * in step.
 *
 * @module @snap-rail/ui/fallback
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'
import { AppShell, Button, EmptyState, IconButton } from './components/index.ts'
import { UI_SLOT_IDS, WINDOW_CONTROLS } from './contract.ts'
import { usePagesVersion } from './pages.tsx'
import { Slot, useUiVersion } from './slots.tsx'

type Action = 'minimize' | 'toggle-maximize' | 'close'

/** A compact glyph for the window controls. */
function Glyph(props: { children: ReactNode }): ReactNode {
  return <span aria-hidden="true" style={{ lineHeight: 1 }}>{props.children}</span>
}

/**
 * The fallback titlebar: the product name and the active page on the left; the
 * contributed `shell.titlebar.actions`, the settings seat, and the window
 * controls on the right. The whole bar is replaced when a plugin occupies
 * `shell.titlebar` — that occupant then owns its own controls.
 */
function DefaultTitlebar(props: { ctx: Context, title: string | undefined, control: (action: Action) => void }): ReactNode {
  return (
    <div
      className="snap-fallback-titlebar"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingLeft: 16 }}
    >
      <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
        snap-rail{props.title !== undefined ? ` · ${props.title}` : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Slot name={UI_SLOT_IDS.titlebarActions} context={{ surface: 'main', controls: WINDOW_CONTROLS }} />
        <Slot
          name={UI_SLOT_IDS.settingsEntry}
          context={{
            presentation: 'icon',
            open: () => props.ctx.settings.open(),
            isOpen: props.ctx.settings.isOpen(),
          }}
        />
        <IconButton icon={<Glyph>—</Glyph>} label="最小化" onClick={() => props.control('minimize')} />
        <IconButton icon={<Glyph>□</Glyph>} label="最大化切换" onClick={() => props.control('toggle-maximize')} />
        <IconButton icon={<Glyph>×</Glyph>} label="关闭" onClick={() => props.control('close')} />
      </div>
    </div>
  )
}

/** The fallback body. */
function FallbackShell(props: { ctx: Context }): ReactNode {
  useUiVersion(props.ctx.ui)
  usePagesVersion(props.ctx)
  const active = props.ctx.pages.active()
  const control = (action: Action): void => {
    void props.ctx.client.link.call('window.control', { action }).catch(() => {})
  }
  // The window bar has one occupant (a layout-level replacement); the sidebar
  // and statusbar are extension seats, so they only take space once something
  // contributes — an empty strip would be a permanent visual tax on every
  // installation that never uses them.
  const titlebarOccupied = props.ctx.ui.list(UI_SLOT_IDS.titlebar).length > 0
  const sidebarOccupied = props.ctx.ui.list(UI_SLOT_IDS.sidebar).length > 0
  const statusbarOccupied = props.ctx.ui.list(UI_SLOT_IDS.statusbar).length > 0
  const header = titlebarOccupied
    ? <Slot name={UI_SLOT_IDS.titlebar} context={{ surface: 'main', controls: WINDOW_CONTROLS }} />
    : <DefaultTitlebar ctx={props.ctx} title={active?.title} control={control} />
  const sidebar = sidebarOccupied
    ? (
        <div
          className="snap-fallback-sidebar"
          style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '4px 8px' }}
        >
          <Slot name={UI_SLOT_IDS.sidebar} context={{ surface: 'main' }} />
        </div>
      )
    : undefined
  const statusbar = statusbarOccupied
    ? (
        <div
          className="snap-fallback-statusbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minHeight: 28,
            padding: '0 12px',
            color: 'var(--snap-color-muted)',
            fontSize: 'var(--snap-text-sm)',
          }}
        >
          <Slot name={UI_SLOT_IDS.statusbar} context={{ surface: 'main' }} />
        </div>
      )
    : undefined
  return (
    <AppShell
      header={header}
      {...sidebar !== undefined ? { sidebar } : {}}
      {...statusbar !== undefined ? { footer: statusbar } : {}}
    >
      {active !== undefined
        ? active.render()
        : (
            <div style={{ display: 'flex', minHeight: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <EmptyState
                title="尚未激活业务套件"
                action={<Button intent="primary" onClick={() => props.ctx.settings.open('plugins')}>打开设置</Button>}
              />
            </div>
          )}
    </AppShell>
  )
}

/** The fallback layout occupant. */
const fallbackPlugin: Plugin.Object<void> = {
  name: 'snap-rail fallback layout',
  inject: ['ui', 'settings', 'pages', 'client'],
  apply(ctx: Context): void {
    ctx.ui.registerLayout(ctx, {
      id: 'fallback',
      order: 200,
      precedence: 0,
      provides: [
        UI_SLOT_IDS.titlebar,
        UI_SLOT_IDS.titlebarActions,
        UI_SLOT_IDS.sidebar,
        UI_SLOT_IDS.statusbar,
        UI_SLOT_IDS.settingsEntry,
      ],
      window: { width: 1280, height: 800, minWidth: 960, minHeight: 600 },
      ball: { size: 128 },
      render: () => <FallbackShell ctx={ctx} />,
    })
  },
}

export default fallbackPlugin
