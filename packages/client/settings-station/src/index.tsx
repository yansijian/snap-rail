/**
 * The settings dialog shell: a layout occupant that renders nothing until
 * `ctx.settingsPages` is open, then shows the registered pages as a menu on
 * the left and the active page's content on the right. Pages come from any
 * plugin via the settings seam; the shell itself contributes the first-party
 * plugin management page (the `plugins.list` / `plugins.setEnabled` surface).
 *
 * @module @snap-rail/settings-station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
// Wire rows for the plugins-domain methods this page calls.
import '@snap-rail/app-boot/contract'
import '@snap-rail/client-settings'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import { Badge, Button, Dialog, DialogContent, DialogTitle, Switch, useRefresh } from '@snap-rail/client-ui'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

/** One row of the plugin management table. */
interface PluginRow {
  name: string
  source: 'builtin' | 'user' | 'pool'
  enabled: boolean
}

/** The first-party plugin management page: every plugin with its enable switch. */
function PluginsPage({ ctx }: { ctx: Context }): ReactNode {
  const [rows, setRows] = useState<readonly PluginRow[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void ctx.client.link.call('plugins.list', {})
      .then(result => {
        if (cancelled) return
        if (result.ok) setRows(result.value.plugins.map(info => ({ name: info.name, source: info.source, enabled: info.enabled })))
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [ctx])

  const toggle = (name: string, enabled: boolean): void => {
    setRows(current => current.map(row => row.name === name ? { ...row, enabled } : row))
    void ctx.client.link.call('plugins.set-enabled', { name, enabled })
      .then(result => {
        if (!result.ok) setRows(current => current.map(row => row.name === name ? { ...row, enabled: !enabled } : row))
      })
      .catch(() => setRows(current => current.map(row => row.name === name ? { ...row, enabled: !enabled } : row)))
  }

  if (failed) return <div className="text-sm text-muted-foreground">插件列表读取失败。</div>

  return (
    <div data-region="plugins-table" className="flex flex-col gap-1">
      <p className="mb-2 text-xs text-muted-foreground">
        宿主插件的启停写入用户层配置并当场热生效；页面类（渲染端）插件的行同样写入该文件，但需重启应用后生效。启用状态与配置同源（文件即接口）。
      </p>
      {rows.map(row => (
        <div
          key={row.name}
          data-plugin-row={row.name}
          className="flex items-center justify-between rounded-md border border-border px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">{row.source === 'builtin' ? '内置' : row.source === 'user' ? '用户层' : '插件池'}</Badge>
            <span className="truncate font-mono text-xs">{row.name}</span>
          </div>
          <Switch
            aria-label={`启用 ${row.name}`}
            checked={row.enabled}
            onCheckedChange={checked => toggle(row.name, checked)}
          />
        </div>
      ))}
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
        className="flex h-[85vh] max-h-[85vh] w-[60vw] max-w-none flex-col gap-0 p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">设置</DialogTitle>
          <Button variant="ghost" size="sm" aria-label="关闭设置" onClick={() => ctx.settingsPages.close()}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav data-region="settings-menu" className="flex w-[200px] shrink-0 flex-col gap-1 overflow-auto border-r border-border p-2">
            {pages.map(page => (
              <button
                key={page.id}
                data-settings-page={page.id}
                aria-current={page.active || undefined}
                className={`rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${page.active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground'}`}
                onClick={() => ctx.settingsPages.open(page.id)}
              >
                {page.title}
              </button>
            ))}
          </nav>
          <div data-region="settings-content" data-active-page={activeId} className="min-w-0 flex-1 overflow-auto p-4">
            {active?.render()}
          </div>
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
    ctx.settingsPages.register(ctx, {
      id: 'plugins',
      title: '插件管理',
      order: 0,
      render(): ReactNode {
        return <PluginsPage ctx={ctx} />
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
