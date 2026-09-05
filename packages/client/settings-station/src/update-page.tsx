/**
 * The 软件更新 settings page: one live snapshot of the update channel plus
 * its two configuration seats. The phase (and progress) arrive as full
 * `update/status` snapshots, so the view is a pure projection — check /
 * download / restart-to-install buttons map one-to-one onto the update
 * domain's methods, and the feed URL / auto-check seats write
 * `settings.json` keys (hot-applied, no restart).
 *
 * @module @snap-rail/settings-station/update-page
 */

// Wire rows for the update-domain methods and the settings keys this page calls.
import '@snap-rail/app-boot/contract'
import {
  UPDATE_AUTO_CHECK_KEY,
  UPDATE_FEED_URL_KEY,
  updateStatusSchema,
  type UpdateStatus,
} from '@snap-rail/app-boot/contract'
import type { Context } from '@snap-rail/cordis'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { Button, Input, Label, Switch } from '@snap-rail/client-ui'
import { useEffect, useState, type ReactNode } from 'react'

/** The phase's one-line copy; `error`/`unconfigured` carry their own message. */
function phaseHint(status: UpdateStatus): string {
  switch (status.phase) {
    case 'unsupported': return '当前为开发模式，无法检查更新。'
    case 'unconfigured': return status.message ?? '未配置更新源。'
    case 'idle': return '就绪，可手动检查更新。'
    case 'checking': return '正在检查更新…'
    case 'available': return '发现新版本，正在后台自动下载。'
    case 'none': return '已是最新版本。'
    case 'downloading': return `正在下载新版本… ${Math.round(status.percent ?? 0)}%`
    case 'ready': return '新版本已就绪，重启后自动完成安装。'
    case 'error': return `更新失败：${status.message ?? '未知错误'}`
  }
}

/** The 软件更新 page. */
export function UpdatePage({ ctx }: { ctx: Context }): ReactNode {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedError, setFeedError] = useState<string | undefined>(undefined)
  const [autoCheck, setAutoCheck] = useState(true)

  const link = ctx.client.link

  // Mount reads seed the snapshot and the two seats; the frames keep every
  // surface converged afterwards (update/status on every transition,
  // settings/changed when a seat changes — including our own writes).
  useEffect(() => {
    void link.call('update.state', {}).then(result => {
      if (result.ok) setStatus(result.value.status)
      else setFailed(true)
    }).catch(() => setFailed(true))
    void link.call('settings.get', { key: UPDATE_AUTO_CHECK_KEY }).then(result => {
      if (result.ok && typeof result.value.value === 'boolean') setAutoCheck(result.value.value)
    }).catch(() => undefined)
    void link.call('settings.get', { key: UPDATE_FEED_URL_KEY }).then(result => {
      if (result.ok && typeof result.value.value === 'string') setFeedUrl(result.value.value)
    }).catch(() => undefined)
    const offStatus = subscribeFrame(link, 'update/status', updateStatusSchema, next => setStatus(next))
    const offSettings = subscribeFrame(link, 'settings/changed', settingsChangedSchema, change => {
      if (change.key === UPDATE_FEED_URL_KEY) setFeedUrl(typeof change.value === 'string' ? change.value : '')
      if (change.key === UPDATE_AUTO_CHECK_KEY) setAutoCheck(change.value !== false)
    })
    return () => {
      offStatus()
      offSettings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])

  /** Run a snapshot-returning update method; failures surface next to the buttons. */
  const run = (method: 'update.check' | 'update.download'): void => {
    setBusy(true)
    setActionError(undefined)
    void link.call(method, {}).then(result => {
      if (result.ok) setStatus(result.value.status)
      else setActionError(rpcErrorText(result.error))
      setBusy(false)
    }).catch(() => setBusy(false))
  }

  const install = (): void => {
    setBusy(true)
    setActionError(undefined)
    void link.call('update.install', {}).then(result => {
      if (!result.ok) {
        setActionError(rpcErrorText(result.error))
        setBusy(false)
      }
      // On success the host quits into the installer; nothing left to render.
    }).catch(() => setBusy(false))
  }

  const saveFeedUrl = (): void => {
    const value = feedUrl.trim()
    if (value !== '') {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setFeedError('请填写 http(s) 开头的更新源地址')
        return
      }
    }
    setFeedError(undefined)
    void link.call('settings.set', { key: UPDATE_FEED_URL_KEY, value })
  }

  if (failed) return <div className="text-sm text-muted-foreground">更新状态读取失败。</div>
  if (status === undefined) return <div className="text-sm text-muted-foreground">正在连接更新通道…</div>

  const phase = status.phase
  const showCheck = phase === 'idle' || phase === 'none' || phase === 'error' || phase === 'available'
  const percent = Math.min(100, Math.max(0, Math.round(status.percent ?? 0)))

  return (
    <div data-region="update-page" className="flex max-w-xl flex-col gap-4">
      <div data-update-status={phase} className="flex flex-col gap-3 rounded-md border border-border px-4 py-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">当前版本</span>
          <span className="font-mono text-sm">{status.currentVersion}</span>
        </div>
        {status.version !== undefined && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">新版本</span>
            <span className="font-mono text-sm">{status.version}</span>
          </div>
        )}
        <p data-update-hint className="text-sm text-muted-foreground">{phaseHint(status)}</p>
        {phase === 'downloading' && (
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            data-update-progress={percent}
            className="h-2 w-full overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        )}
        {actionError !== undefined && <p data-update-error className="text-sm text-destructive">{actionError}</p>}
        <div className="flex items-center gap-2">
          {showCheck && (
            <Button data-update-check disabled={busy} onClick={() => run('update.check')}>
              {phase === 'error' ? '重新检查' : '检查更新'}
            </Button>
          )}
          {phase === 'available' && (
            <Button data-update-download variant="outline" disabled={busy} onClick={() => run('update.download')}>
              立即下载
            </Button>
          )}
          {phase === 'ready' && (
            <Button data-update-install disabled={busy} onClick={install}>重启并安装</Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">启动时自动检查更新</span>
            <span className="text-xs text-muted-foreground">发现新版本后自动后台下载；安装仍需手动确认重启。</span>
          </div>
          <Switch
            aria-label="启动时自动检查更新"
            checked={autoCheck}
            onCheckedChange={next => {
              setAutoCheck(next)
              void link.call('settings.set', { key: UPDATE_AUTO_CHECK_KEY, value: next })
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="update-feed-url">更新源地址</Label>
          <div className="flex items-center gap-2">
            <Input
              id="update-feed-url"
              value={feedUrl}
              placeholder="https://updates.example.com/snap-rail/"
              onChange={event => setFeedUrl(event.target.value)}
            />
            <Button variant="outline" data-update-save-feed onClick={saveFeedUrl}>保存</Button>
          </div>
          {feedError !== undefined && <p className="text-sm text-destructive">{feedError}</p>}
          <p className="text-xs text-muted-foreground">
            指向存放安装包与 latest.yml 的目录；留空时使用安装包内置配置。保存后再点「检查更新」立即生效。
          </p>
        </div>
      </div>
    </div>
  )
}
