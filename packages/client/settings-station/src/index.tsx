/**
 * The settings dialog shell: a layout occupant that renders nothing until
 * `ctx.settingsPages` is open, then shows the registered pages as a menu on
 * the left and the active page's content on the right. Pages come from any
 * plugin via the settings seam; the shell itself contributes the first-party
 * plugin management page (the three-section `plugins.*` surface).
 *
 * @module @snap-rail/settings-station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/client-settings'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import { subscribeFrame } from '@snap-rail/connection'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import {
  Button, Dialog, DialogContent, DialogTitle, DragScroll, Tabs, TabsList, TabsTrigger, useRefresh,
  applyTheme, DEFAULT_THEME, themeSettingsSchema, THEME_SETTINGS_KEY, type ThemeSettings,
} from '@snap-rail/client-ui'
import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { MarketPage } from './market-page.tsx'
import { PluginsPage } from './plugins-page.tsx'
import { UpdatePage } from './update-page.tsx'

/** The 主题 settings page: one mode choice (跟随系统/白天/黑夜). The write
 * hot-applies everywhere via the `settings/changed` frame — no restart. */
function ThemePage(props: { initial: ThemeSettings, onChoose: (next: ThemeSettings) => void }): ReactNode {
  const [mode, setMode] = useState<ThemeSettings['mode']>(props.initial.mode)
  return (
    <div data-region="theme-page" className="flex max-w-xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">模式立即生效并写入配置文件；跟随系统时随操作系统的日夜间设置自动切换。</p>
      <Tabs
        value={mode}
        onValueChange={next => {
          const choice = next as ThemeSettings['mode']
          setMode(choice)
          props.onChoose({ mode: choice })
        }}
      >
        <TabsList aria-label="主题模式">
          <TabsTrigger value="system" data-mode-option="system">跟随系统</TabsTrigger>
          <TabsTrigger value="light" data-mode-option="light">白天</TabsTrigger>
          <TabsTrigger value="dark" data-mode-option="dark">黑夜</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  )
}

/** The dialog shell: left menu over the registry, right content of the active page. */
function SettingsDialog({ ctx }: { ctx: Context }): ReactNode {
  useRefresh(ctx, ['settings/open-changed', 'settings/pages-changed'])

  const open = ctx.settingsPages.isOpen()
  const pages = ctx.settingsPages.list()
  const activeId = ctx.settingsPages.active()
  const active = pages.find(page => page.id === activeId)

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) ctx.settingsPages.close() }}>
      <DialogContent
        data-region="settings-dialog"
        aria-describedby={undefined}
        className="flex h-5/6 max-h-5/6 w-3/5 max-w-none flex-col gap-0 p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <DialogTitle className="text-lg font-medium">设置</DialogTitle>
          <Button variant="ghost" size="icon" aria-label="关闭设置" onClick={() => ctx.settingsPages.close()}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <DragScroll
            data-region="settings-menu"
            className="flex w-60 shrink-0 flex-col gap-1 border-r border-border p-2"
          >
            {pages.map(page => (
              <button
                key={page.id}
                type="button"
                data-settings-page={page.id}
                aria-current={page.active || undefined}
                className={`flex h-12 w-full items-center rounded-md px-4 text-left text-base transition-colors hover:bg-accent ${page.active ? 'bg-accent font-medium text-accent-foreground channel-keyline' : 'text-muted-foreground'}`}
                onClick={() => ctx.settingsPages.open(page.id)}
              >
                {page.title}
              </button>
            ))}
          </DragScroll>
          <DragScroll
            data-region="settings-content"
            data-active-page={activeId}
            className="min-w-0 flex-1 p-6"
          >
            {active?.render()}
          </DragScroll>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The settings dialog occupant. */
const settingsStationPlugin: Plugin.Object<void> = {
  name: 'settings-station',
  inject: ['uiSlots', 'settingsPages', 'client'],
  apply(ctx: Context): void {
    // Theme: apply the stored row (settings.json `ui.theme`) to <html> right
    // away, keep every surface hot-synced through the settings/changed
    // frame, and follow the OS preference while in system mode. The page
    // below is the only writer; its write re-enters through the frame.
    let theme: ThemeSettings = DEFAULT_THEME
    const adoptTheme = (value: unknown): void => {
      const parsed = themeSettingsSchema.safeParse(value)
      if (!parsed.success) return
      theme = parsed.data
      applyTheme(document, theme)
    }
    applyTheme(document, theme)
    void ctx.client.link.call('settings.get', { key: THEME_SETTINGS_KEY })
      .then(result => { if (result.ok) adoptTheme(result.value.value) })
      .catch(() => {})
    ctx.effect(() => subscribeFrame(ctx.client.link, 'settings/changed', settingsChangedSchema, change => {
      if (change.key === THEME_SETTINGS_KEY) adoptTheme(change.value)
    }))
    const osPreference = window.matchMedia('(prefers-color-scheme: light)')
    ctx.effect(() => {
      const sync = (): void => { if (theme.mode === 'system') applyTheme(document, theme) }
      osPreference.addEventListener('change', sync)
      return () => { osPreference.removeEventListener('change', sync) }
    })
    const chooseTheme = (next: ThemeSettings): void => {
      theme = next
      applyTheme(document, next)
      void ctx.client.link.call('settings.set', { key: THEME_SETTINGS_KEY, value: next })
    }

    ctx.settingsPages.register(ctx, {
      id: 'plugins',
      title: '插件管理',
      order: 0,
      render(): ReactNode {
        return <PluginsPage ctx={ctx} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'theme',
      title: '主题',
      order: 1,
      render(): ReactNode {
        return <ThemePage initial={theme} onChoose={chooseTheme} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'update',
      title: '软件更新',
      order: 2,
      render(): ReactNode {
        return <UpdatePage ctx={ctx} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'market',
      title: '插件市场',
      order: 3,
      render(): ReactNode {
        return <MarketPage ctx={ctx} />
      },
    })
    ctx.uiSlots.register(ctx, 'layout', {
      id: 'settings-dialog',
      order: 100,
      render(): ReactNode {
        return <SettingsDialog ctx={ctx} />
      },
    })
  },
}

export default settingsStationPlugin
