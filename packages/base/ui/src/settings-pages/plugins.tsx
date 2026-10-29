/**
 * The built-in 插件管理 settings page: a category-grouped, flat list of
 * installable pool plugins plus the full install pipeline — a tri-form
 * input (feed search term / http(s) address / local path), a drag-in .zip
 * drop zone, the feed-source editor, pending-update pills, and the
 * inspect→confirm→install flow with its unverified-signature risk step.
 * Rows are one package each; enabling/disabling writes the same
 * `plugins.yml` the file interface uses and asks for a restart because
 * renderer rows only re-mount at boot. Every action rides the regular
 * `plugins.*` wire methods — the same pipeline the kernel's recovery page
 * bootstraps with (that page keeps its own self-contained copy: it renders
 * precisely when this substrate is dead).
 *
 * @module @snap-rail/ui/settings-pages/plugins
 */

import type { Context } from '@snap-rail/cordis'
import type { InspectedArchive, PluginInfo, PluginSignature, PluginUpdate, RemotePluginInfo } from '@snap-rail/app-boot/contract'
import { PLUGINS_FEED_URLS_KEY } from '@snap-rail/app-boot/contract'
import '@snap-rail/app-boot/contract'
import { rpcErrorText } from '@snap-rail/connection'
import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Page, Section, Stack, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/index.ts'

/** The preload's zip→path bridge (`webUtils.getPathForFile`); null outside
 * Electron or in tests. Inlined rather than imported from the app-internal
 * kernel package: it never ships in the installer, and the packaged-app gate
 * refuses any shipped `@snap-rail/ui` lib that requires it. */
function droppedZipPath(file: File): string | null {
  const zipPathOf = (globalThis as { snapRail?: { zipPathOf?: unknown } }).snapRail?.zipPathOf
  if (typeof zipPathOf !== 'function') return null
  return (zipPathOf as (candidate: File) => string | null)(file)
}

/** Human labels for the package kinds. */
const KIND_LABELS: Record<string, string> = {
  skin: '界面风格',
  driver: '通讯驱动',
  suite: '业务套件',
  plugin: '插件',
}

const PROFILE_LABELS: Record<string, string> = {
  native: '皮肤原生',
  integrated: '图表桥接',
  custom: '自定义界面',
}

/** Search rows shown before the tail is folded into a counter. */
const SEARCH_ROW_CAP = 20

/** One page row: a package, not an individual subpath entry. */
interface PackageRow {
  packageName: string
  title: string
  category: string
  kind: string
  version?: string
  enabled: boolean
  source: PluginInfo['source']
  builtinDefault: boolean
  clientOnly: boolean
  uiProfile?: string
}

/** Collapse entry rows into package rows (one master switch per package). */
function packageRows(plugins: readonly PluginInfo[]): PackageRow[] {
  const byPackage = new Map<string, PackageRow>()
  for (const plugin of plugins) {
    if (plugin.source === 'builtin') continue
    const existing = byPackage.get(plugin.packageName)
    if (existing !== undefined) {
      existing.enabled = existing.enabled || plugin.enabled
      continue
    }
    byPackage.set(plugin.packageName, {
      packageName: plugin.packageName,
      title: plugin.title ?? plugin.packageName,
      category: plugin.category ?? '其他',
      kind: plugin.kind ?? 'plugin',
      ...plugin.version !== undefined ? { version: plugin.version } : {},
      enabled: plugin.enabled,
      source: plugin.source,
      builtinDefault: plugin.source === 'builtin-default',
      clientOnly: plugin.clientOnly === true,
      ...(plugin.uiProfile !== undefined ? { uiProfile: plugin.uiProfile } : {}),
    })
  }
  return [...byPackage.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
}

/** The preview's signature line (one row in the confirm card). */
function signatureText(signature: PluginSignature, viaUrl: boolean): { text: string, warning: boolean } {
  if (signature.state === 'verified') {
    return { text: `✓ 已验证 · ${signature.publisher ?? signature.keyId}`, warning: false }
  }
  const detail = signature.keyId !== undefined ? `⚠ 未验证 · keyId ${signature.keyId}（未登记）` : '⚠ 未签名'
  return { text: viaUrl ? `${detail} · 直链无完整性校验` : detail, warning: true }
}

/** Does the input name an http(s) address? */
const isHttpUrl = (text: string): boolean => /^https?:\/\//i.test(text)

/** Does the input look like a filesystem path (drive letter, UNC, posix
 * root, or a .zip name with a separator in it)? */
const looksLikePath = (text: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
  || (/\.zip$/i.test(text) && /[/\\]/.test(text))

/** Inline status/error line under the install input (one message at a time). */
interface Message {
  kind: 'error' | 'info'
  text: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm', zipPath: string, archive: InspectedArchive, viaUrl: boolean, risk: boolean }
  | { kind: 'installing' }
  | { kind: 'error', message: string }

/** The plugin management page. */
export function PluginsPage({ ctx }: { ctx: Context }): ReactNode {
  const [rows, setRows] = useState<readonly PackageRow[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [restartNeeded, setRestartNeeded] = useState(false)
  // The install pipeline: tri-form input, its search results, and the
  // inspect→confirm→install phase machine (mirrors the kernel recovery page).
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [message, setMessage] = useState<Message | undefined>(undefined)
  const [updates, setUpdates] = useState<ReadonlyMap<string, PluginUpdate>>(new Map())
  const [updatingName, setUpdatingName] = useState<string | undefined>(undefined)
  const [keyChange, setKeyChange] = useState<PluginUpdate | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly RemotePluginInfo[] | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The feed-source panel: the draft list, its input, and its own error line.
  const [feedOpen, setFeedOpen] = useState(false)
  const [feedUrls, setFeedUrls] = useState<readonly string[]>([])
  const [feedDraft, setFeedDraft] = useState('')
  const [feedError, setFeedError] = useState<string | undefined>(undefined)

  const link = ctx.client.link

  const load = (): void => {
    setError(undefined)
    void link.call('plugins.list', {}).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setRows(packageRows(result.value.plugins))
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    void link.call('plugins.updates-check', {}).then(result => {
      if (result.ok) setUpdates(new Map(result.value.updates.map(update => [update.name, update])))
    }).catch(() => undefined)
  }

  useEffect(() => {
    load()
    // The user's feed list rides settings.json — read once for the editor
    // (an empty read means the factory default list is in force).
    void link.call('settings.get', { key: PLUGINS_FEED_URLS_KEY }).then(result => {
      if (result.ok && Array.isArray(result.value.value)) {
        setFeedUrls(result.value.value.filter((entry): entry is string => typeof entry === 'string'))
      }
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  const toggle = (row: PackageRow, enabled: boolean): void => {
    setBusy(row.packageName)
    void link.call('plugins.set-enabled', { name: row.packageName, enabled })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setRows(current => current.map(item => item.packageName === row.packageName ? { ...item, enabled } : item))
        setTouched(current => new Set(current).add(row.packageName))
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(undefined) })
  }

  const uninstall = (row: PackageRow): void => {
    if (!window.confirm(`卸载 ${row.title}？该包的数据也会一起删除。`)) return
    setBusy(row.packageName)
    void link.call('plugins.uninstall', { name: row.packageName })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setTouched(current => new Set(current).add(row.packageName))
        setRestartNeeded(true)
        load()
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(undefined) })
  }

  const inspectPath = (zipPath: string): void => {
    setMessage(undefined)
    void link.call('plugins.inspect', { zipPath }).then(result => {
      if (!result.ok) {
        setPhase({ kind: 'error', message: `读取插件包失败：${rpcErrorText(result.error)}` })
        return
      }
      setPhase({ kind: 'confirm', zipPath, archive: result.value.archive, viaUrl: false, risk: false })
    }).catch(cause => setPhase({ kind: 'error', message: String(cause) }))
  }

  const inspectFromUrl = (url: string): void => {
    setMessage(undefined)
    void link.call('plugins.inspect-from-url', { url }).then(result => {
      if (!result.ok) {
        setPhase({ kind: 'error', message: `下载或读取插件包失败：${rpcErrorText(result.error)}` })
        return
      }
      setPhase({ kind: 'confirm', zipPath: result.value.zipPath, archive: result.value.archive, viaUrl: true, risk: false })
    }).catch(cause => setPhase({ kind: 'error', message: String(cause) }))
  }

  const runInstall = (zipPath: string, archive: InspectedArchive): void => {
    setPhase({ kind: 'installing' })
    const call = archive.kind === 'combo'
      ? link.call('plugins.install-combo', { zipPath })
      : link.call('plugins.install', { zipPath })
    void call.then(result => {
      if (!result.ok) {
        setPhase({ kind: 'error', message: `安装失败：${rpcErrorText(result.error)}` })
        return
      }
      setPhase({ kind: 'idle' })
      setRestartNeeded(true)
      load()
    }).catch(cause => setPhase({ kind: 'error', message: String(cause) }))
  }

  /** The update pill's click: a plain update installs directly; a key
   * change confirmation intercepts first. */
  const requestUpdate = (update: PluginUpdate): void => {
    if (update.keyChanged === true) {
      setKeyChange(update)
      return
    }
    updateNow(update.name)
  }

  /** The update itself: the feed's entry, no preview. */
  const updateNow = (name: string): void => {
    setKeyChange(undefined)
    setUpdatingName(name)
    setMessage(undefined)
    void link.call('plugins.remote-install', { name }).then(result => {
      setUpdatingName(undefined)
      if (!result.ok) {
        setMessage({ kind: 'error', text: rpcErrorText(result.error) })
        return
      }
      setRestartNeeded(true)
      load()
    }).catch(() => setUpdatingName(undefined))
  }

  /** The tri-form input: address/path → inspect, anything else → feed search. */
  const submitQuery = (): void => {
    const text = query.trim()
    if (text === '') return
    setMessage(undefined)
    if (isHttpUrl(text)) {
      inspectFromUrl(text)
      return
    }
    if (looksLikePath(text)) {
      inspectPath(text)
      return
    }
    runSearch(text)
  }

  const runSearch = (text: string): void => {
    setSearching(true)
    setSearchResults(undefined)
    void link.call('plugins.remote-list', {}).then(result => {
      setSearching(false)
      if (!result.ok) {
        setMessage({ kind: 'error', text: `搜索失败：${rpcErrorText(result.error)}` })
        return
      }
      const needle = text.toLowerCase()
      setSearchResults(result.value.plugins.filter(item =>
        item.name.toLowerCase().includes(needle)
        || (item.title ?? '').toLowerCase().includes(needle)
        || (item.description ?? '').toLowerCase().includes(needle)))
    }).catch(cause => {
      setSearching(false)
      setMessage({ kind: 'error', text: String(cause) })
    })
  }

  /** A search-result entry that is not installed yet: preview first. The
   * entry's own coordinates decide where the zip comes from — a federation
   * row downloads from the author's release, a same-directory row from its
   * feed base. */
  const previewRemote = (item: RemotePluginInfo): void => {
    if (item.url !== undefined) {
      inspectFromUrl(item.url)
      return
    }
    if (item.feedUrl === undefined || item.file === undefined) return
    const base = item.feedUrl.endsWith('/') ? item.feedUrl : `${item.feedUrl}/`
    inspectFromUrl(`${base}${item.file}`)
  }

  const saveFeedUrls = (): void => {
    for (const url of feedUrls) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setFeedError('插件源地址需要以 http(s) 开头')
        return
      }
    }
    setFeedError(undefined)
    void link.call('settings.set', { key: PLUGINS_FEED_URLS_KEY, value: feedUrls }).then(result => {
      if (!result.ok) {
        setFeedError(rpcErrorText(result.error))
        return
      }
      setFeedOpen(false)
    }).catch(cause => setFeedError(String(cause)))
  }

  const appendFeedUrl = (): void => {
    const value = feedDraft.trim()
    if (value === '') return
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    } catch {
      setFeedError('请填写 http(s) 开头的插件源地址')
      return
    }
    setFeedError(undefined)
    setFeedDraft('')
    setFeedUrls(current => current.includes(value) ? current : [...current, value])
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file === undefined) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setMessage({ kind: 'error', text: '只支持 .zip 插件包或组合包' })
      return
    }
    const zipPath = droppedZipPath(file)
    if (zipPath === null) {
      setMessage({ kind: 'error', text: '当前环境不支持拖拽安装（缺少路径桥）' })
      return
    }
    inspectPath(zipPath)
  }

  const restart = (): void => {
    void link.call('window.relaunch', {})
  }

  const visibleResults = searchResults?.slice(0, SEARCH_ROW_CAP)

  const groups = new Map<string, PackageRow[]>()
  for (const row of rows) {
    const bucket = groups.get(row.category)
    if (bucket === undefined) groups.set(row.category, [row])
    else bucket.push(row)
  }

  return (
    <Page
      title="插件管理"
      description="安装驱动、业务页面和界面风格。启用/停用写入 plugins.yml，渲染端在下一次重启后生效。"
      actions={(
        <div style={{ display: 'flex', gap: 'var(--snap-space-sm)' }}>
          {restartNeeded && <Button intent="primary" onClick={restart}>重启生效</Button>}
          <Button intent="neutral" emphasis="outline" onClick={load}>刷新</Button>
        </div>
      )}
    >
      <Stack gap="lg">
        {error !== undefined && <div role="alert" style={{ color: 'var(--snap-color-danger)' }}>{error}</div>}

        <Section title="安装插件">
          <Stack gap="sm">
            <div style={{ display: 'flex', gap: 'var(--snap-space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                intent="neutral"
                emphasis="outline"
                aria-label="配置插件源"
                title="配置插件源"
                onClick={() => setFeedOpen(true)}
              >
                ⚙
              </Button>
              <Input
                value={query}
                placeholder="粘贴本地/网络地址安装，或输入名称搜索…"
                style={{ flex: 1, minWidth: 200 }}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') submitQuery() }}
              />
              <Button intent="neutral" emphasis="outline" disabled={searching} onClick={submitQuery}>
                {searching ? '搜索中…' : '搜索'}
              </Button>
              <div
                data-plugins-dropzone
                onDragOver={event => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                style={{
                  padding: '6px 12px',
                  border: `1px dashed ${dragging ? 'var(--snap-color-accent)' : 'var(--snap-color-border)'}`,
                  borderRadius: 'var(--snap-radius-sm)',
                  fontSize: 'var(--snap-text-xs)',
                  color: 'var(--snap-color-muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                拖入 .zip 安装
              </div>
            </div>
            {message !== undefined && (
              <div
                role={message.kind === 'error' ? 'alert' : 'status'}
                style={{ fontSize: 'var(--snap-text-xs)', color: message.kind === 'error' ? 'var(--snap-color-danger)' : 'var(--snap-color-muted)' }}
              >
                {message.text}
              </div>
            )}
            {visibleResults !== undefined && (
              <Stack gap="sm">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 'var(--snap-text-sm)', color: 'var(--snap-color-muted)' }}>
                    搜索“{query.trim()}”（{searchResults?.length ?? 0}）
                  </span>
                  <Button intent="neutral" emphasis="ghost" size="sm" onClick={() => setSearchResults(undefined)}>✕</Button>
                </div>
                {visibleResults.length === 0 && (
                  <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
                    没有匹配的插件。
                  </div>
                )}
                {visibleResults.map(item => {
                  const installed = item.installed !== undefined
                  return (
                    <div
                      key={item.name}
                      style={{
                        display: 'flex', gap: 'var(--snap-space-md)', alignItems: 'center',
                        justifyContent: 'space-between', borderBottom: '1px solid var(--snap-color-border)', paddingBottom: 'var(--snap-space-sm)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 'var(--snap-space-sm)', alignItems: 'center' }}>
                          {item.title ?? item.name}
                          {item.source !== undefined && <Badge intent="neutral">{item.source}</Badge>}
                        </div>
                        <div style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>{item.name} · {item.version}</div>
                      </div>
                      {item.action === 'install'
                        ? <Button intent="primary" emphasis="outline" size="sm" onClick={() => previewRemote(item)}>安装</Button>
                        : item.action === 'update' && installed
                          ? (
                              <Button
                                intent="primary"
                                emphasis="ghost"
                                size="sm"
                                title={`当前 ${item.installed?.version} → ${item.version}，点击更新`}
                                disabled={updatingName === item.name}
                                onClick={() => requestUpdate({
                                  name: item.name,
                                  installedVersion: item.installed?.version ?? '',
                                  feedVersion: item.version,
                                })}
                              >
                                {updatingName === item.name ? '更新中…' : `⟳ ${item.version}`}
                              </Button>
                            )
                          : <span style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>{item.action === 'current' ? '已是最新' : '本地更新'}</span>}
                    </div>
                  )
                })}
                {(searchResults?.length ?? 0) > SEARCH_ROW_CAP && (
                  <div style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>
                    已显示前 {SEARCH_ROW_CAP} 条，共 {searchResults?.length} 条。
                  </div>
                )}
              </Stack>
            )}
          </Stack>
        </Section>

        {rows.length === 0
          ? <EmptyState title="还没有安装插件" description="粘贴地址、拖入插件/组合 .zip，或从插件源搜索安装。" />
          : [...groups.entries()].map(([category, entries]) => (
              <Section key={category} title={category}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map(row => {
                      const update = updates.get(row.packageName)
                      return (
                        <TableRow key={row.packageName}>
                          <TableCell>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--snap-space-sm)' }}>
                                {row.title}
                                {row.builtinDefault && <Badge intent="neutral">内置默认</Badge>}
                              </span>
                              <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-xs)' }}>{row.packageName}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {KIND_LABELS[row.kind] ?? row.kind}
                            {row.uiProfile !== undefined && (
                              <Badge intent="neutral">{PROFILE_LABELS[row.uiProfile] ?? row.uiProfile}</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {update !== undefined
                              ? (
                                  <Button
                                    intent="primary"
                                    emphasis="ghost"
                                    size="sm"
                                    title={update.keyChanged === true
                                      ? `当前 ${update.installedVersion} → ${update.feedVersion}，发布者密钥已变更，点击确认更新`
                                      : `当前 ${update.installedVersion} → ${update.feedVersion}，点击更新`}
                                    disabled={updatingName === row.packageName}
                                    onClick={() => requestUpdate(update)}
                                  >
                                    {updatingName === row.packageName ? '更新中…' : `⟳ ${update.feedVersion}`}
                                  </Button>
                                )
                              : (row.version ?? '—')}
                          </TableCell>
                          <TableCell>
                            {row.builtinDefault
                              ? <Badge intent="success">始终随底座</Badge>
                              : (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--snap-space-sm)' }}>
                                    <Switch
                                      checked={row.enabled}
                                      disabled={busy === row.packageName}
                                      onCheckedChange={next => toggle(row, next)}
                                      aria-label={`启用 ${row.title}`}
                                    />
                                    {touched.has(row.packageName) && <Badge intent="warning">待重启</Badge>}
                                  </div>
                                )}
                          </TableCell>
                          <TableCell>
                            {row.builtinDefault
                              ? <span style={{ color: 'var(--snap-color-muted)' }}>内置默认不可卸载</span>
                              : (
                                  <Button
                                    intent="danger"
                                    emphasis="ghost"
                                    size="sm"
                                    disabled={busy === row.packageName}
                                    onClick={() => uninstall(row)}
                                  >
                                    卸载
                                  </Button>
                                )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </Section>
            ))}
      </Stack>

      <Dialog
        open={phase.kind === 'confirm' || phase.kind === 'installing' || phase.kind === 'error'}
        onOpenChange={next => {
          if (!next && phase.kind !== 'installing') setPhase({ kind: 'idle' })
        }}
      >
        <DialogContent presentation="modal">
          <DialogHeader>
            <DialogTitle>
              {phase.kind === 'confirm'
                ? phase.archive.kind === 'combo'
                  ? '安装组合套件'
                  : phase.archive.plugin.action === 'update' ? '更新插件' : '安装插件'
                : phase.kind === 'error' ? '安装失败' : '正在安装…'}
            </DialogTitle>
            <DialogDescription>
              {phase.kind === 'confirm' && phase.archive.kind === 'combo'
                ? `${phase.archive.combo.title} · ${phase.archive.combo.id}`
                : '请核对包名、版本与签名状态后再继续。'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {phase.kind === 'error' && (
              <div style={{ color: 'var(--snap-color-danger)', whiteSpace: 'pre-wrap', fontSize: 'var(--snap-text-sm)' }}>{phase.message}</div>
            )}
            {phase.kind === 'confirm' && phase.archive.kind === 'combo' && (
              <Stack gap="sm">
                {phase.archive.combo.description !== undefined && (
                  <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>{phase.archive.combo.description}</div>
                )}
                <div style={{ display: 'grid', gap: 'var(--snap-space-xs)', fontSize: 'var(--snap-text-sm)' }}>
                  <div>插件（{phase.archive.combo.plugins.length}）</div>
                  {phase.archive.combo.plugins.map(plugin => {
                    const line = signatureText(plugin.signature, phase.viaUrl)
                    const action = plugin.action === 'install' ? '安装' : plugin.action === 'update' ? '更新' : '保留'
                    return (
                      <div key={plugin.name} style={{ color: line.warning ? 'var(--snap-color-warning)' : undefined }}>
                        {plugin.title ?? plugin.name} {plugin.version} · {action}{line.warning ? ' · ⚠ 未验证' : ''}
                      </div>
                    )
                  })}
                </div>
                <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-xs)' }}>
                  组合包本身不签名；每个成员都经与单插件相同的签名校验。
                </div>
                {phase.archive.combo.missing.length > 0 && (
                  <div style={{ color: 'var(--snap-color-danger)', fontSize: 'var(--snap-text-sm)' }}>
                    缺少依赖：{phase.archive.combo.missing.join('、')}——组合会立即启用全部行，装齐后再安装。
                  </div>
                )}
              </Stack>
            )}
            {phase.kind === 'confirm' && phase.archive.kind === 'plugin' && (
              <Stack gap="sm">
                {phase.risk ? (
                  <div data-plugins-risk style={{ color: 'var(--snap-color-warning)', fontWeight: 600 }}>
                    ⚠ 此插件未经发布者验证
                  </div>
                ) : undefined}
                {!phase.risk && (
                  <Stack gap="sm">
                    {phase.archive.plugin.title !== undefined && <div>名称：{phase.archive.plugin.title}</div>}
                    <div>包名：{phase.archive.plugin.name}</div>
                    {phase.archive.plugin.action === 'update'
                      ? (
                          <>
                            <div>已安装版本：{phase.archive.plugin.installed?.version}</div>
                            <div>将更新至：{phase.archive.plugin.version}</div>
                          </>
                        )
                      : <div>版本：{phase.archive.plugin.version}</div>}
                  </Stack>
                )}
                {(() => {
                  const line = signatureText(phase.archive.plugin.signature, phase.viaUrl)
                  return (
                    <div data-plugins-signature={phase.archive.plugin.signature.state} style={{ color: line.warning ? 'var(--snap-color-warning)' : undefined }}>
                      签名：{line.text}
                    </div>
                  )
                })()}
                {!phase.risk && (
                  <Stack gap="sm">
                    <div>权限：{phase.archive.plugin.permissions.length === 0 ? '无' : phase.archive.plugin.permissions.join('、')}</div>
                    {phase.archive.plugin.missing.length > 0 && (
                      <div style={{ color: 'var(--snap-color-danger)', fontSize: 'var(--snap-text-sm)' }}>
                        尚未安装的依赖：{phase.archive.plugin.missing.join('、')}——可先安装本包，启用前需装齐。
                      </div>
                    )}
                    {phase.archive.plugin.action === 'blocked' && (
                      <div style={{ color: 'var(--snap-color-danger)', fontSize: 'var(--snap-text-sm)' }}>
                        已安装 v{phase.archive.plugin.installed?.version}，安装包 v{phase.archive.plugin.version} 不高于已装版本，无法覆盖。
                      </div>
                    )}
                  </Stack>
                )}
                {phase.risk && (
                  <Stack gap="sm">
                    <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
                      {phase.archive.plugin.signature.keyId !== undefined
                        ? `签名 keyId ${phase.archive.plugin.signature.keyId} 不在本机信任名单中，无法验证发布者。`
                        : '这个包没有携带任何签名，也没有任何完整性校验。'}
                    </div>
                    <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
                      · 插件将按其声明的权限在宿主内运行（当前声明：{phase.archive.plugin.permissions.length === 0 ? '无' : phase.archive.plugin.permissions.join('、')}）。
                    </div>
                    <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>· 请确认来源可信后再继续。</div>
                  </Stack>
                )}
              </Stack>
            )}
          </DialogBody>
          <DialogFooter>
            {phase.kind === 'error' && (
              <Button intent="neutral" emphasis="outline" onClick={() => setPhase({ kind: 'idle' })}>返回</Button>
            )}
            {phase.kind === 'confirm' && (
              <>
                <Button intent="neutral" emphasis="outline" onClick={() => setPhase({ kind: 'idle' })}>取消</Button>
                {phase.risk
                  ? (
                      <Button
                        intent="primary"
                        data-plugins-risk-confirm
                        onClick={() => runInstall(phase.zipPath, phase.archive)}
                      >
                        我知晓风险，仍要安装
                      </Button>
                    )
                  : (
                      <Button
                        intent="primary"
                        data-plugins-install-confirm
                        disabled={phase.archive.kind === 'plugin' && phase.archive.plugin.action === 'blocked'}
                        onClick={() => {
                          if (phase.archive.kind === 'plugin' && phase.archive.plugin.signature.state === 'unverified') {
                            setPhase({ ...phase, risk: true })
                            return
                          }
                          runInstall(phase.zipPath, phase.archive)
                        }}
                      >
                        {phase.archive.kind === 'combo' ? '安装组合' : phase.archive.plugin.action === 'update' ? '更新' : '安装'}
                      </Button>
                    )}
              </>
            )}
            {phase.kind === 'installing' && <span style={{ color: 'var(--snap-color-muted)' }}>正在安装…</span>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={keyChange !== undefined} onOpenChange={next => { if (!next) setKeyChange(undefined) }}>
        <DialogContent presentation="modal">
          <DialogHeader>
            <DialogTitle>发布者密钥已变更</DialogTitle>
            <DialogDescription>
              {keyChange?.name} 的新版本由不同的密钥签名。若发布者确实轮换了密钥，更新是安全的；否则不要继续。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {keyChange !== undefined && (
              <div style={{ fontSize: 'var(--snap-text-sm)' }}>
                已安装 v{keyChange.installedVersion} → 源上 v{keyChange.feedVersion}。请核对发布者公告中的新 keyId 后再决定。
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button intent="neutral" emphasis="outline" onClick={() => setKeyChange(undefined)}>取消</Button>
            <Button intent="primary" data-plugins-keychange-confirm onClick={() => keyChange !== undefined && updateNow(keyChange.name)}>仍要更新</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={feedOpen} onOpenChange={setFeedOpen}>
        <DialogContent presentation="modal">
          <DialogHeader>
            <DialogTitle>插件源</DialogTitle>
            <DialogDescription>搜索与在线更新使用的插件源列表：</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Stack gap="sm">
              {feedUrls.length === 0 && (
                <div style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>尚未添加自定义源（当前使用出厂默认源）。</div>
              )}
              {feedUrls.map((url, index) => (
                <div key={url} style={{ display: 'flex', gap: 'var(--snap-space-sm)', alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--snap-text-xs)' }}>{url}</span>
                  <Button intent="neutral" emphasis="ghost" size="sm" aria-label={`移除 ${url}`} onClick={() => setFeedUrls(current => current.filter((_, at) => at !== index))}>✕</Button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 'var(--snap-space-sm)' }}>
                <Input
                  value={feedDraft}
                  placeholder="https://…（指向含 index.json 的目录）"
                  style={{ flex: 1 }}
                  onChange={event => setFeedDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') appendFeedUrl() }}
                />
                <Button intent="neutral" emphasis="outline" onClick={appendFeedUrl}>添加源</Button>
              </div>
              {feedError !== undefined && (
                <div role="alert" style={{ color: 'var(--snap-color-danger)', fontSize: 'var(--snap-text-sm)' }}>{feedError}</div>
              )}
              <div style={{ fontSize: 'var(--snap-text-xs)', color: 'var(--snap-color-muted)' }}>
                未修改时使用出厂默认源；修改后保存在本机，仅影响本机。社区插件源就是插件作者自己仓库的 Release 地址。
              </div>
            </Stack>
          </DialogBody>
          <DialogFooter>
            <Button intent="neutral" emphasis="outline" onClick={() => setFeedOpen(false)}>取消</Button>
            <Button intent="primary" data-plugins-feed-save onClick={saveFeedUrls}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}
