/**
 * The no-framework recovery console: when no UI framework face is enabled,
 * this page is the terminal's whole interface. One list carries everything —
 * installed pool packages (enable/disable, uninstall) merged with the
 * configured plugin source's catalog (install, update) — with the drag-in
 * zip path and the source address as secondary affordances below. Every
 * action rides the regular `plugins.*` wire methods, so the bootstrap page
 * is a client of the very pipeline it bootstraps. Built-in rows never list:
 * `plugins.list` is filtered to pool sources, replacement is a source
 * rebuild. Styling stays local by design: theme tokens arrive only with a
 * framework.
 *
 * @module @snap-rail/client-kernel/BootstrapPage
 */

import { useCallback, useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { HostLink } from '@snap-rail/connection'
import type { RpcError } from '@snap-rail/protocol'
import type { InspectedPlugin, PluginInfo, RemotePluginInfo } from '@snap-rail/app-boot/contract'
import { PLUGINS_FEED_URL_KEY } from '@snap-rail/app-boot/contract'
/** Local error text (the kernel cannot reach the framework's rpcErrorText). */
function errorText(error: RpcError): string {
  if (error.code === 'bad-request') return error.details.issues.join('；')
  if (error.code === 'internal') return error.details.hint ?? '内部错误'
  return error.details.what
}

/** Turn a dropped File back into its host-side path; null when the carrier
 * (or the test host) offers no bridge. */
export type ZipPathOf = (file: File) => string | null

/** What the page needs from its host: the wire and the drop bridge. */
export interface BootstrapPageProps {
  link: HostLink
  zipPathOf: ZipPathOf
  onClose: () => void
  /** A failure surfaced by whoever fell back to this page (a framework
   * runtime crash, an ABI refusal) — rendered as a banner above the page. */
  notice?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm'; zipPath: string; plugin: InspectedPlugin }
  | { kind: 'installing'; zipPath: string }

/** One line of the unified list: an installed pool package, a catalog
 * entry, or both merged (an installed package the source can update). */
interface MergedRow {
  name: string
  title?: string
  category?: string
  installed?: PluginInfo
  remote?: RemotePluginInfo
}

/** Inline status/error line under the list (one message at a time). */
interface Message {
  kind: 'error' | 'info'
  text: string
}

const stylePage: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#0b0d10',
  color: '#e6e8eb',
  fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
}

const styleButton: CSSProperties = {
  padding: '8px 18px',
  border: '1px solid #3a4048',
  borderRadius: 6,
  background: '#1b1f24',
  color: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
}

const stylePrimary: CSSProperties = { ...styleButton, background: '#2563eb', borderColor: '#2563eb' }

const styleDanger: CSSProperties = { ...styleButton, color: '#f87171', borderColor: '#7f1d1d' }

const styleInput: CSSProperties = {
  width: 340,
  padding: '8px 10px',
  border: '1px solid #3a4048',
  borderRadius: 6,
  background: '#14171b',
  color: 'inherit',
  fontSize: 13,
}

const styleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  border: '1px solid #23282e',
  borderRadius: 6,
}

const styleBadge: CSSProperties = { fontSize: 12, color: '#f59e0b', whiteSpace: 'nowrap' }

/** The action badge text for one catalog entry (local verdict included). */
function actionLabel(action: RemotePluginInfo['action']): string | undefined {
  if (action === 'update') return '可更新'
  if (action === 'current') return '已是最新'
  if (action === 'local-newer') return '本地更新'
  return undefined
}

/** Whether a catalog entry's install affordance is enabled (current and
 * local-newer entries have nothing to land). */
function actionInstallable(action: RemotePluginInfo['action']): boolean {
  return action === 'install' || action === 'update'
}

/** Merge installed pool rows with catalog entries, installed first. A
 * catalog entry whose name matches an installed row decorates it (update
 * affordance); the rest append. */
function mergeRows(installed: readonly PluginInfo[], remote: readonly RemotePluginInfo[] | undefined): MergedRow[] {
  const rows = new Map<string, MergedRow>()
  for (const info of installed) {
    rows.set(info.name, {
      name: info.name,
      ...info.title !== undefined ? { title: info.title } : {},
      ...info.category !== undefined ? { category: info.category } : {},
      installed: info,
    })
  }
  for (const entry of remote ?? []) {
    const existing = rows.get(entry.name)
    if (existing !== undefined) {
      existing.remote = entry
      continue
    }
    rows.set(entry.name, {
      name: entry.name,
      ...entry.title !== undefined ? { title: entry.title } : {},
      ...entry.category !== undefined ? { category: entry.category } : {},
      remote: entry,
    })
  }
  return [...rows.values()].sort((a, b) => {
    const installedFirst = Number(b.installed !== undefined) - Number(a.installed !== undefined)
    if (installedFirst !== 0) return installedFirst
    const at = a.title ?? a.name
    const bt = b.title ?? b.name
    return at.localeCompare(bt, 'zh-Hans-CN')
  })
}

/** Render the recovery console. See {@link BootstrapPageProps}. */
export function BootstrapPage(props: BootstrapPageProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [rows, setRows] = useState<readonly MergedRow[]>([])
  const [restartNeeded, setRestartNeeded] = useState(false)
  // The plugin source section: address → the catalog merges into the list.
  const [feedInput, setFeedInput] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [busyRow, setBusyRow] = useState<string | undefined>(undefined)
  const [remoteBusy, setRemoteBusy] = useState<string | undefined>(undefined)

  /** Reload the unified list: installed pool rows plus, when a source is
   * configured, its catalog verdicts. Failures degrade to the remote half. */
  const refresh = useCallback(async (source: string): Promise<void> => {
    const list = await props.link.call('plugins.list', {})
    const installed = list.ok ? list.value.plugins.filter(row => row.source === 'pool') : []
    let remote: readonly RemotePluginInfo[] | undefined
    if (source !== '') {
      const catalog = await props.link.call('plugins.remote-list', {})
      if (catalog.ok) remote = catalog.value.plugins
      else setMessage({ kind: 'error', text: `读取插件源失败：${errorText(catalog.error)}` })
    }
    setRows(mergeRows(installed, remote))
  }, [props.link])

  useEffect(() => {
    void props.link.call('settings.get', { key: PLUGINS_FEED_URL_KEY }).then(result => {
      const value = result.ok && typeof result.value.value === 'string' ? result.value.value : ''
      setFeedInput(value)
      setFeedUrl(value)
    }).catch(() => setFeedUrl(''))
  }, [props.link])

  useEffect(() => {
    void refresh(feedUrl)
  }, [feedUrl, refresh])

  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file === undefined) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setMessage({ kind: 'error', text: '只支持 .zip 插件包' })
      return
    }
    const zipPath = props.zipPathOf(file)
    if (zipPath === null) {
      setMessage({ kind: 'error', text: '当前环境不支持拖拽安装（缺少路径桥）' })
      return
    }
    setMessage(undefined)
    const result = await props.link.call('plugins.inspect', { zipPath })
    if (!result.ok) {
      setMessage({ kind: 'error', text: `读取插件包失败：${errorText(result.error)}` })
      return
    }
    setPhase({ kind: 'confirm', zipPath, plugin: result.value.plugin })
  }

  const install = async (zipPath: string): Promise<void> => {
    setPhase({ kind: 'installing', zipPath })
    const result = await props.link.call('plugins.install', { zipPath })
    if (!result.ok) {
      setPhase({ kind: 'idle' })
      setMessage({ kind: 'error', text: `安装失败：${errorText(result.error)}` })
      return
    }
    setPhase({ kind: 'idle' })
    setRestartNeeded(true)
    await refresh(feedUrl)
  }

  const toggle = async (row: MergedRow): Promise<void> => {
    if (row.installed === undefined) return
    setBusyRow(row.name)
    setMessage(undefined)
    const result = await props.link.call('plugins.set-enabled', { name: row.installed.name, enabled: !row.installed.enabled })
    setBusyRow(undefined)
    if (!result.ok) {
      setMessage({ kind: 'error', text: errorText(result.error) })
      return
    }
    setRestartNeeded(true)
    await refresh(feedUrl)
  }

  const uninstall = async (row: MergedRow): Promise<void> => {
    if (row.installed === undefined) return
    setBusyRow(row.name)
    setMessage(undefined)
    const result = await props.link.call('plugins.uninstall', { name: row.installed.name })
    setBusyRow(undefined)
    if (!result.ok) {
      setMessage({ kind: 'error', text: errorText(result.error) })
      return
    }
    setRestartNeeded(true)
    await refresh(feedUrl)
  }

  const installRemote = async (name: string): Promise<void> => {
    setRemoteBusy(name)
    setMessage(undefined)
    const result = await props.link.call('plugins.remote-install', { name })
    setRemoteBusy(undefined)
    if (!result.ok) {
      setMessage({ kind: 'error', text: errorText(result.error) })
      return
    }
    setRestartNeeded(true)
    await refresh(feedUrl)
  }

  const saveFeed = async (): Promise<void> => {
    const value = feedInput.trim()
    const result = await props.link.call('settings.set', { key: PLUGINS_FEED_URL_KEY, value })
    if (!result.ok) {
      setMessage({ kind: 'error', text: errorText(result.error) })
      return
    }
    setFeedUrl(value)
    setMessage({ kind: 'info', text: value === '' ? '已清除插件源地址' : '已保存' })
  }

  const restart = async (): Promise<void> => {
    await props.link.call('window.relaunch', {})
  }

  const listBusy = busyRow !== undefined || remoteBusy !== undefined

  const center: ReactNode = phase.kind === 'confirm'
    ? (
        <div style={{ display: 'grid', gap: 12, minWidth: 320, textAlign: 'left' }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{phase.plugin.title ?? phase.plugin.name}</div>
          {phase.plugin.title !== undefined
            ? <div style={{ fontSize: 13, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>{phase.plugin.name}</div>
            : undefined}
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            版本 {phase.plugin.version}
            {phase.plugin.category !== undefined ? ` · 分类 ${phase.plugin.category}` : ''}
            {phase.plugin.hasClient ? ' · 含页面' : ''}
          </div>
          {phase.plugin.permissions.length > 0
            ? <div style={{ fontSize: 13, opacity: 0.8 }}>权限：{phase.plugin.permissions.join('、')}</div>
            : undefined}
          {phase.plugin.missing.length > 0
            ? (
                <div style={{ fontSize: 13, color: '#f59e0b' }}>
                  缺少依赖（可先安装，启用前需装齐）：{phase.plugin.missing.join('、')}
                </div>
              )
            : undefined}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={stylePrimary} onClick={() => void install(phase.zipPath)}>安装</button>
            <button type="button" style={styleButton} onClick={() => setPhase({ kind: 'idle' })}>取消</button>
          </div>
        </div>
      )
    : phase.kind === 'installing'
      ? <div style={{ opacity: 0.7 }}>正在安装…</div>
      : (
          <div style={{ width: 640, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, opacity: 0.85 }}>插件（{rows.length}）</div>
              <button type="button" style={{ ...styleButton, padding: '4px 12px' }} disabled={listBusy} onClick={() => void refresh(feedUrl)}>刷新</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', gap: 6, alignContent: 'start' }}>
              {rows.length === 0
                ? (
                    <div style={{ padding: '32px 0', textAlign: 'center', opacity: 0.55, fontSize: 14 }}>
                      列表为空 —— 配置插件源在线安装，或拖入 .zip 插件包
                    </div>
                  )
                : rows.map(row => {
                    const installed = row.installed
                    const version = installed?.version ?? row.remote?.version
                    const badge = row.remote !== undefined ? actionLabel(row.remote.action) : undefined
                    const installable = row.remote !== undefined && actionInstallable(row.remote.action)
                    return (
                      <div key={row.name} style={styleRow}>
                        {installed !== undefined
                          ? (
                              <input
                                type="checkbox"
                                aria-label={`${row.title ?? row.name} 启用`}
                                checked={installed.enabled}
                                disabled={listBusy}
                                onChange={() => void toggle(row)}
                              />
                            )
                          : undefined}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14 }}>{row.title ?? row.name}{row.category !== undefined ? `（${row.category}）` : ''}</div>
                          <div style={{ fontSize: 12, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>
                            {row.name}{version !== undefined ? ` · ${version}` : ''}
                          </div>
                        </div>
                        {badge !== undefined ? <span style={styleBadge}>{badge}</span> : undefined}
                        {installable
                          ? (
                              <button
                                type="button"
                                style={row.remote?.action === 'update' ? stylePrimary : styleButton}
                                disabled={listBusy}
                                onClick={() => void installRemote(row.name)}
                              >
                                {remoteBusy === row.name ? '安装中…' : (row.remote?.action === 'update' ? '更新' : '安装')}
                              </button>
                            )
                          : undefined}
                        {installed !== undefined
                          ? (
                              <button
                                type="button"
                                style={styleDanger}
                                disabled={listBusy}
                                title="卸载（删除插件包；其数据保留）"
                                onClick={() => void uninstall(row)}
                              >
                                卸载
                              </button>
                            )
                          : undefined}
                      </div>
                    )
                  })}
              {message !== undefined
                ? (
                    <div style={{ fontSize: 12, color: message.kind === 'error' ? '#f87171' : 'inherit', opacity: message.kind === 'error' ? 1 : 0.75 }}>
                      {message.text}
                    </div>
                  )
                : undefined}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid #23282e', paddingTop: 10 }}>
              <div
                onDragOver={event => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={event => void onDrop(event)}
                style={{
                  padding: '8px 14px',
                  border: `1px dashed ${dragging ? '#2563eb' : '#3a4048'}`,
                  borderRadius: 6,
                  background: dragging ? '#141a22' : 'transparent',
                  fontSize: 12,
                  opacity: dragging ? 1 : 0.7,
                  whiteSpace: 'nowrap',
                  transition: 'border-color .15s, background .15s',
                }}
              >
                拖入 .zip 安装
              </div>
              <input
                value={feedInput}
                placeholder="插件源地址（http://…）"
                onChange={event => setFeedInput(event.target.value)}
                style={{ ...styleInput, flex: 1, width: 'auto' }}
              />
              <button type="button" style={styleButton} onClick={() => void saveFeed()}>保存</button>
            </div>
          </div>
        )

  return (
    <div style={stylePage}>
      <header style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>
        <button type="button" aria-label="关闭" style={styleButton} onClick={props.onClose}>✕</button>
      </header>
      {props.notice !== undefined
        ? (
            <div
              style={{
                margin: '0 16px 8px',
                padding: '10px 14px',
                border: '1px solid #7f1d1d',
                borderRadius: 6,
                background: '#2a1215',
                color: '#fca5a5',
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {props.notice}
            </div>
          )
        : undefined}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>{center}</main>
      {restartNeeded
        ? (
            <footer style={{ borderTop: '1px solid #23282e', padding: '12px 16px', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" style={stylePrimary} onClick={() => void restart()}>
                重启生效
              </button>
            </footer>
          )
        : undefined}
    </div>
  )
}
