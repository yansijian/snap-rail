/**
 * The built-in fallback layout: a minimal titlebar, a settings seat, window
 * controls, and an empty state pointing at the plugin manager. It is an
 * ordinary low-precedence layout occupant, not a special shell branch; a
 * suite layout with higher precedence replaces it and its disposal brings the
 * fallback back automatically.
 *
 * @module @snap-rail/ui/fallback
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'
import { AppShell, Button, EmptyState, IconButton } from './components/index.ts'
import { UI_SLOT_IDS } from './contract.ts'
import { usePagesVersion } from './pages.tsx'
import { Slot, useUiVersion } from './slots.tsx'

type Action = 'minimize' | 'toggle-maximize' | 'close'

/** A compact glyph for the window controls. */
function Glyph(props: { children: ReactNode }): ReactNode {
  return <span aria-hidden="true" style={{ lineHeight: 1 }}>{props.children}</span>
}

/** The fallback body. */
function FallbackShell(props: { ctx: Context }): ReactNode {
  useUiVersion(props.ctx.ui)
  usePagesVersion(props.ctx)
  const active = props.ctx.pages.active()
  const control = (action: Action): void => {
    void props.ctx.client.link.call('window.control', { action }).catch(() => {})
  }
  const header = (
    <div
      className="snap-fallback-titlebar"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingLeft: 16 }}
    >
      <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
        snap-rail{active !== undefined ? ` · ${active.title}` : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Slot
          name={UI_SLOT_IDS.settingsEntry}
          context={{
            presentation: 'icon',
            open: () => props.ctx.settings.open(),
            isOpen: props.ctx.settings.isOpen(),
          }}
        />
        <IconButton icon={<Glyph>—</Glyph>} label="最小化" onClick={() => control('minimize')} />
        <IconButton icon={<Glyph>□</Glyph>} label="最大化切换" onClick={() => control('toggle-maximize')} />
        <IconButton icon={<Glyph>×</Glyph>} label="关闭" onClick={() => control('close')} />
      </div>
    </div>
  )
  return (
    <AppShell header={header}>
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