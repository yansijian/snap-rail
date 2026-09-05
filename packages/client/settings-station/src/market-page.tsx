/**
 * The 插件市场 settings page: the configured plugin feed as one browsable
 * catalog. The host fetches the feed's `index.json` and annotates every
 * entry with the local verdict (install / update / current / local-newer);
 * installing rides `plugins.remote-install` — the same strictly-higher
 * pipeline as a local zip install, so the pool stays the single truth. The
 * feed base URL is a settings key (`plugins.feedUrl`), hot-applied.
 *
 * @module @snap-rail/settings-station/market-page
 */

// Wire rows for the plugins-domain methods this page calls.
import '@snap-rail/app-boot/contract'
import { PLUGINS_FEED_URL_KEY, type RemoteAction, type RemotePluginInfo } from '@snap-rail/app-boot/contract'
import type { Context } from '@snap-rail/cordis'
import { rpcErrorText } from '@snap-rail/connection'
import { Badge, Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input, Label } from '@snap-rail/client-ui'
import { useEffect, useState, type ReactNode } from 'react'
import { KIND_LABELS } from './plugins-page.tsx'

/** Action → badge text/variant: what the market says about one row. */
const ACTION_BADGES: Record<RemoteAction, { text: string, variant: 'default' | 'secondary' }> = {
  install: { text: '可安装', variant: 'default' },
  update: { text: '可更新', variant: 'default' },
  current: { text: '已是最新', variant: 'secondary' },
  'local-newer': { text: '本地更新', variant: 'secondary' },
}

/** The 插件市场 page. */
export function MarketPage({ ctx }: { ctx: Context }): ReactNode {
  const [feedUrl, setFeedUrl] = useState('')
  const [feedError, setFeedError] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'unconfigured'>('loading')
  const [items, setItems] = useState<readonly RemotePluginInfo[]>([])
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [busyName, setBusyName] = useState<string | undefined>(undefined)
  const [restartPrompt, setRestartPrompt] = useState(false)
  const [rendererNames, setRendererNames] = useState<readonly string[]>([])

  const link = ctx.client.link

  /** Re-read the catalog; only meaningful with a configured feed. */
  const refresh = (url: string): void => {
    if (url === '') {
      setPhase('unconfigured')
      return
    }
    setPhase('loading')
    setErrorMessage(undefined)
    void link.call('plugins.remote-list', {}).then(result => {
      if (result.ok) {
        setItems(result.value.plugins)
        setPhase('ready')
      } else {
        setErrorMessage(rpcErrorText(result.error))
        setPhase('error')
      }
    }).catch(cause => {
      setErrorMessage(String(cause))
      setPhase('error')
    })
  }

  useEffect(() => {
    void link.call('settings.get', { key: PLUGINS_FEED_URL_KEY }).then(result => {
      const value = result.ok && typeof result.value.value === 'string' ? result.value.value : ''
      setFeedUrl(value)
      refresh(value)
    }).catch(() => setPhase('unconfigured'))
    void link.call('client-config.list', {}).then(result => {
      if (result.ok) setRendererNames(result.value.rows.map(row => row.name))
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])

  const saveFeedUrl = (): void => {
    const value = feedUrl.trim()
    if (value !== '') {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setFeedError('请填写 http(s) 开头的插件源地址')
        return
      }
    }
    setFeedError(undefined)
    void link.call('settings.set', { key: PLUGINS_FEED_URL_KEY, value }).then(() => refresh(value))
  }

  const install = (name: string): void => {
    setBusyName(name)
    setErrorMessage(undefined)
    void link.call('plugins.remote-install', { name }).then(result => {
      setBusyName(undefined)
      if (!result.ok) {
        setErrorMessage(rpcErrorText(result.error))
        return
      }
      refresh(feedUrl.trim())
      // An update swapped the package under a possibly-running renderer
      // face — same restart surface as the plugins page's flows.
      if (result.value.installed.updated && rendererNames.includes(result.value.installed.name)) {
        setRestartPrompt(true)
      }
    }).catch(() => setBusyName(undefined))
  }

  const relaunch = (): void => {
    void link.call('window.relaunch', {}).catch(() => undefined)
  }

  return (
    <div data-region="market-page" className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="market-feed-url">插件源地址</Label>
        <div className="flex items-center gap-2">
          <Input
            id="market-feed-url"
            value={feedUrl}
            placeholder="http://更新服务器/snap-rail/plugins/"
            onChange={event => setFeedUrl(event.target.value)}
          />
          <Button variant="outline" data-market-save-feed onClick={saveFeedUrl}>保存</Button>
          <Button variant="outline" data-market-refresh disabled={phase === 'loading' || feedUrl.trim() === ''} onClick={() => refresh(feedUrl.trim())}>
            刷新
          </Button>
        </div>
        {feedError !== undefined && <p className="text-sm text-destructive">{feedError}</p>}
        <p className="text-xs text-muted-foreground">
          指向插件源目录（内含 index.json 与插件包）；保存后立即生效。
        </p>
      </div>

      {phase === 'unconfigured' && (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
          尚未配置插件源：填写上方地址并保存后，即可浏览与安装远端插件。
        </div>
      )}
      {phase === 'loading' && <div className="text-sm text-muted-foreground">正在读取插件源…</div>}
      {phase === 'error' && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive px-4 py-4">
          <p data-market-error className="text-sm text-destructive">{errorMessage}</p>
          <div>
            <Button variant="outline" size="sm" onClick={() => refresh(feedUrl.trim())}>重试</Button>
          </div>
        </div>
      )}
      {phase === 'ready' && items.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">插件源为空。</div>
      )}
      {phase === 'ready' && items.length > 0 && (
        <div data-market-list className="flex flex-col gap-2">
          {items.map(item => {
            const badge = ACTION_BADGES[item.action]
            const installable = item.action === 'install' || item.action === 'update'
            return (
              <div
                key={item.name}
                data-market-row={item.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{item.name}</span>
                    <Badge variant="secondary">{KIND_LABELS[item.kind ?? 'plugin'] ?? item.kind ?? '插件'}</Badge>
                    <Badge variant={badge.variant} data-market-action={item.action}>{badge.text}</Badge>
                  </div>
                  {item.description !== undefined && item.description !== '' && (
                    <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                  )}
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    源版本 v{item.version}
                    {item.installed !== undefined && ` · 已安装 v${item.installed.version}`}
                  </span>
                </div>
                {installable && (
                  <Button
                    size="sm"
                    data-market-install={item.name}
                    disabled={busyName !== undefined}
                    onClick={() => install(item.name)}
                  >
                    {busyName === item.name ? '安装中…' : item.action === 'update' ? '更新' : '安装'}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {restartPrompt && (
        <Dialog open onOpenChange={next => { if (!next) setRestartPrompt(false) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">变更待重启生效</DialogTitle>
            <p className="text-sm text-muted-foreground">页面类插件的更新将在下次启动时生效，旧界面残留也会随之消失。</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestartPrompt(false)}>稍后</Button>
              <Button data-restart-now onClick={relaunch}>立即重启</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
