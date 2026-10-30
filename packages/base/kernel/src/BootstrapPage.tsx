/**
 * The no-framework plugin page: when no UI framework face is enabled — or
 * the framework crashed after taking the root — this plain-React surface is
 * the terminal's whole interface, the same shape the settings 插件 page has
 * under a framework. One tri-form input (local path / http(s) address /
 * drag-in zip inspects that package; any other text searches the configured
 * feed), the installed list below with the version cell doubling as the
 * update affordance, and a red anomaly strip whenever a notice rode in
 * (framework crash, refused face). Every action rides the regular
 * `plugins.*` wire methods, so this page is a client of the very pipeline
 * it bootstraps. Built-in rows never list: replacement is a source rebuild.
 * Styling stays local by design: theme tokens arrive only with a framework,
 * so the palette below mirrors the framework's dark-mode token values
 * (single source: the framework repo's `src/ui/theme.css`, see
 * docs/theme.md) — change them together.
 *
 * @module @snap-rail/client-kernel/BootstrapPage
 */

import { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { HostLink } from '@snap-rail/connection'
import type { RpcError } from '@snap-rail/protocol'
import type { InspectedArchive, PluginInfo, PluginSignature, PluginUpdate, RemotePluginInfo } from '@snap-rail/app-boot/contract'
import { PLUGINS_FEED_URLS_KEY } from '@snap-rail/app-boot/contract'

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
   * runtime crash, an ABI refusal) — rendered as the red anomaly strip. */
  notice?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm'; zipPath: string; archive: InspectedArchive; viaUrl: boolean; risk: boolean }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }

/** Inline status/error line under the input (one message at a time). */
interface Message {
  kind: 'error' | 'info'
  text: string
}

/** The preview's signature line (one row in the confirm card). */
function signatureText(signature: PluginSignature, viaUrl: boolean): { text: string; warning: boolean } {
  if (signature.state === 'verified') {
    return { text: `✓ 已验证 · ${signature.publisher ?? signature.keyId}`, warning: false }
  }
  const detail = signature.keyId !== undefined ? `⚠ 未验证 · keyId ${signature.keyId}（未登记）` : '⚠ 未签名'
  return { text: viaUrl ? `${detail} · 直链无完整性校验` : detail, warning: true }
}

/** Does the archive carry any unsigned/unknown-key member? A combo archive
 * has no signature of its own — each member's verdict decides. */
function archiveAtRisk(archive: InspectedArchive): boolean {
  return archive.kind === 'plugin'
    ? archive.plugin.signature.state === 'unverified'
    : archive.combo.plugins.some(plugin => plugin.signature.state === 'unverified')
}

/** Does the input name an http(s) address? */
const isHttpUrl = (text: string): boolean => /^https?:\/\//i.test(text)

/** Does the input look like a filesystem path (drive letter, UNC, posix
 * root, or a .zip name with a separator in it)? */
const looksLikePath = (text: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
  || (/\.zip$/i.test(text) && /[/\\]/.test(text))

/**
 * Mirrored framework theme tokens (dark mode), as values — the bootstrap
 * page renders before any framework face exists, so tokens cannot be
 * imported. Keep in step with the framework repo's `src/ui/theme.css`.
 */
const theme = {
  background: '#0b0f14',
  card: '#11161d',
  popover: '#161b22',
  secondary: '#1c2430',
  foreground: '#ced8e3',
  mutedForeground: '#8b949e',
  primary: '#4a6cff',
  success: '#3fb950',
  warning: '#d29922',
  destructive: '#f85149',
  border: '#1f2933',
} as const

const stylePage: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: theme.background,
  color: theme.foreground,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
}

const styleButton: CSSProperties = {
  padding: '8px 14px',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const stylePrimary: CSSProperties = { ...styleButton, background: theme.primary, borderColor: theme.primary }

const styleDanger: CSSProperties = { ...styleButton, color: theme.destructive, borderColor: 'rgba(248,81,73,.45)' }

const styleInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '8px 10px',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: theme.popover,
  color: 'inherit',
  fontSize: 13,
}

/** The muted version pill — inert until a feed update is pending. */
const styleVersionIdle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  border: `1px solid ${theme.border}`,
  borderRadius: 999,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  color: theme.mutedForeground,
  whiteSpace: 'nowrap',
}

/** The pending-update pill: success-colored, carries the refresh glyph and
 * the feed version; clicking it installs the update. */
const styleVersionUpdate: CSSProperties = {
  ...styleVersionIdle,
  border: '1px solid rgba(63,185,80,.35)',
  background: 'rgba(63,185,80,.1)',
  color: theme.success,
  cursor: 'pointer',
}

/** The red anomaly strip (framework crash / refused face / no framework). */
const styleNotice: CSSProperties = {
  margin: '0 16px 8px',
  padding: '10px 14px',
  border: '1px solid rgba(248,81,73,.45)',
  borderRadius: 6,
  background: 'rgba(248,81,73,.08)',
  color: theme.destructive,
  fontSize: 13,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const styleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
}

/** The plain overlay every modal surface on this page shares. */
const styleOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11,15,20,.8)',
}

const styleCard: CSSProperties = {
  width: 380,
  maxWidth: '90vw',
  display: 'grid',
  gap: 12,
  padding: 18,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  background: theme.card,
  textAlign: 'left',
}

const styleField: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const styleFieldLabel: CSSProperties = { color: theme.mutedForeground }

/** Search results render at most this many rows — the recovery page never
 * becomes a catalog browser. */
const SEARCH_ROW_CAP = 30

/** Render the recovery plugin page. See {@link BootstrapPageProps}. */
export function BootstrapPage(props: BootstrapPageProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [rows, setRows] = useState<readonly PluginInfo[]>([])
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [message, setMessage] = useState<Message | undefined>(undefined)
  /** The name whose update click is in flight (version pill busy state). */
  const [updatingName, setUpdatingName] = useState<string | undefined>(undefined)
  /** The two-tap uninstall arm: the armed package name. */
  const [armedUninstall, setArmedUninstall] = useState<string | undefined>(undefined)
  /** Pending updates by package name (drives the version pills). */
  const [updates, setUpdates] = useState<ReadonlyMap<string, PluginUpdate>>(new Map())
  /** The pending update whose click hit a key change — confirmed in an
   * overlay card before the install fires. */
  const [keyChange, setKeyChange] = useState<PluginUpdate | undefined>(undefined)
  // The tri-form input and the feed search it can produce.
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly RemotePluginInfo[] | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  // The feed-source panel: the draft list, its input, and its own error line.
  const [feedOpen, setFeedOpen] = useState(false)
  const [feedUrls, setFeedUrls] = useState<readonly string[]>([])
  const [feedDraft, setFeedDraft] = useState('')
  const [feedError, setFeedError] = useState<string | undefined>(undefined)

  const link = props.link

  const reload = (): void => {
    void link.call('plugins.list', {}).then(result => {
      if (result.ok) setRows(result.value.plugins.filter(row => row.source === 'pool'))
    })
    void link.call('plugins.updates-check', {}).then(result => {
      if (result.ok) setUpdates(new Map(result.value.updates.map(update => [update.name, update])))
    }).catch(() => undefined)
  }
  useEffect(() => {
    reload()
    // The user's feed list rides settings.json — read once for the panel
    // (an empty read means the factory default list is in force).
    void link.call('settings.get', { key: PLUGINS_FEED_URLS_KEY }).then(result => {
      if (result.ok && Array.isArray(result.value.value)) {
        setFeedUrls(result.value.value.filter((entry): entry is string => typeof entry === 'string'))
      }
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  const toggle = (name: string, enabled: boolean): void => {
    setRows(current => current.map(row => row.name === name ? { ...row, enabled } : row))
    setArmedUninstall(undefined)
    void link.call('plugins.set-enabled', { name, enabled }).then(result => {
      if (!result.ok) {
        setMessage({ kind: 'error', text: errorText(result.error) })
        reload()
        return
      }
      setRestartNeeded(true)
    }).catch(() => reload())
  }

  /** Two-tap uninstall: the first tap arms (the button reads 确认卸载), the
   * second executes — no modal library exists this deep in the boot. */
  const requestUninstall = (name: string): void => {
    if (armedUninstall !== name) {
      setArmedUninstall(name)
      return
    }
    setArmedUninstall(undefined)
    void link.call('plugins.uninstall', { name }).then(result => {
      if (!result.ok) {
        setMessage({ kind: 'error', text: errorText(result.error) })
        return
      }
      setRestartNeeded(true)
      reload()
    }).catch(cause => setMessage({ kind: 'error', text: String(cause) }))
  }

  const inspectPath = (zipPath: string): void => {
    setMessage(undefined)
    void link.call('plugins.inspect', { zipPath }).then(result => {
      if (!result.ok) {
        setPhase({ kind: 'error', message: `读取插件包失败：${errorText(result.error)}` })
        return
      }
      setPhase({ kind: 'confirm', zipPath, archive: result.value.archive, viaUrl: false, risk: false })
    }).catch(cause => setPhase({ kind: 'error', message: String(cause) }))
  }

  const inspectFromUrl = (url: string): void => {
    setMessage(undefined)
    void link.call('plugins.inspect-from-url', { url }).then(result => {
      if (!result.ok) {
        setPhase({ kind: 'error', message: `下载或读取插件包失败：${errorText(result.error)}` })
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
        setPhase({ kind: 'error', message: `安装失败：${errorText(result.error)}` })
        return
      }
      setPhase({ kind: 'idle' })
      setRestartNeeded(true)
      reload()
    }).catch(cause => setPhase({ kind: 'error', message: String(cause) }))
  }

  /** The version pill's click: a plain update installs directly; a key
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
        setMessage({ kind: 'error', text: errorText(result.error) })
        return
      }
      setRestartNeeded(true)
      reload()
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
        setMessage({ kind: 'error', text: `搜索失败：${errorText(result.error)}` })
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
        setFeedError(errorText(result.error))
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
    const zipPath = props.zipPathOf(file)
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

  const center: ReactNode = phase.kind === 'confirm'
    ? (
        phase.risk
          ? (
              <div style={styleCard}>
                <div data-bootstrap-risk style={{ color: theme.warning, fontSize: 15, fontWeight: 600 }}>
                  {phase.archive.kind === 'combo' ? '⚠ 此组合含未经发布者验证的插件' : '⚠ 此插件未经发布者验证'}
                </div>
                <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                  {phase.archive.kind === 'plugin'
                    ? (
                        <>
                          <p style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{phase.archive.plugin.name}</p>
                          <p style={{ margin: 0, opacity: 0.75 }}>
                            {phase.archive.plugin.signature.keyId !== undefined
                              ? `签名 keyId ${phase.archive.plugin.signature.keyId} 不在本机信任名单中，无法验证发布者。`
                              : '这个包没有携带任何签名，也没有任何完整性校验。'}
                          </p>
                        </>
                      )
                    : (
                        <>
                          <p style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{phase.archive.combo.title} · {phase.archive.combo.id}</p>
                          <p style={{ margin: 0, opacity: 0.75 }}>组合包本身没有签名，以下成员无法验证发布者：</p>
                          <ul style={{ margin: 0, paddingLeft: 18, opacity: 0.75 }}>
                            {phase.archive.combo.plugins
                              .filter(plugin => plugin.signature.state === 'unverified')
                              .map(plugin => (
                                <li key={plugin.name} style={{ fontFamily: 'ui-monospace, monospace' }}>
                                  {plugin.name} · {plugin.signature.keyId ?? '未签名'}
                                </li>
                              ))}
                          </ul>
                        </>
                      )}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" style={styleButton} onClick={() => setPhase({ ...phase, risk: false })}>返回</button>
                  <button type="button" style={stylePrimary} onClick={() => runInstall(phase.zipPath, phase.archive)}>我知晓风险，仍要安装</button>
                </div>
              </div>
            )
          : phase.archive.kind === 'combo'
            ? (
                <div style={styleCard}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>安装组合套件</div>
                  <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                    <div style={styleField}><span style={styleFieldLabel}>组合名</span><span>{phase.archive.combo.title}</span></div>
                    <div style={styleField}><span style={styleFieldLabel}>组合 ID</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.combo.id}</span></div>
                    <div style={styleField}><span style={styleFieldLabel}>版本</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.combo.version}</span></div>
                    {phase.archive.combo.description !== undefined && (
                      <p style={{ margin: 0, opacity: 0.75 }}>{phase.archive.combo.description}</p>
                    )}
                    <div style={{ ...styleField, alignItems: 'baseline' }}>
                      <span style={styleFieldLabel}>插件（{phase.archive.combo.plugins.length}）</span>
                      <span style={{ display: 'grid', gap: 2, textAlign: 'right' }}>
                        {phase.archive.combo.plugins.map(plugin => {
                          const line = signatureText(plugin.signature, phase.viaUrl)
                          const action = plugin.action === 'install' ? '安装' : plugin.action === 'update' ? '更新' : '保留'
                          return (
                            <span key={plugin.name} style={{ color: line.warning ? theme.warning : undefined }}>
                              {plugin.title ?? plugin.name} {plugin.version} · {action}{line.warning ? ' · ⚠ 未验证' : ''}
                            </span>
                          )
                        })}
                      </span>
                    </div>
                    {phase.archive.combo.missing.length > 0 && (
                      <p style={{ margin: 0, color: theme.destructive, fontSize: 13 }}>
                        缺少依赖：{phase.archive.combo.missing.join('、')}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" style={styleButton} onClick={() => setPhase({ kind: 'idle' })}>取消</button>
                    <button
                      type="button"
                      style={stylePrimary}
                      disabled={phase.archive.combo.missing.length > 0}
                      onClick={() => {
                        if (archiveAtRisk(phase.archive)) {
                          setPhase({ ...phase, risk: true })
                          return
                        }
                        runInstall(phase.zipPath, phase.archive)
                      }}
                    >
                      安装组合
                    </button>
                  </div>
                </div>
              )
            : (
                <div style={styleCard}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{phase.archive.plugin.action === 'update' ? '更新插件' : '安装插件'}</div>
                  <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                    {phase.archive.plugin.title !== undefined && <div style={styleField}><span style={styleFieldLabel}>名称</span><span>{phase.archive.plugin.title}</span></div>}
                    <div style={styleField}><span style={styleFieldLabel}>包名</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.plugin.name}</span></div>
                    {phase.archive.plugin.action === 'update'
                      ? (
                          <>
                            <div style={styleField}><span style={styleFieldLabel}>已安装版本</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.plugin.installed?.version}</span></div>
                            <div style={styleField}><span style={styleFieldLabel}>将更新至</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.plugin.version}</span></div>
                          </>
                        )
                      : <div style={styleField}><span style={styleFieldLabel}>版本</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{phase.archive.plugin.version}</span></div>}
                    {(() => {
                      const line = signatureText(phase.archive.plugin.signature, phase.viaUrl)
                      return (
                        <div
                          data-bootstrap-signature={phase.archive.plugin.signature.state}
                          style={{ ...styleField, color: line.warning ? theme.warning : undefined }}
                        >
                          <span style={styleFieldLabel}>签名</span><span>{line.text}</span>
                        </div>
                      )
                    })()}
                    <div style={styleField}><span style={styleFieldLabel}>权限</span><span>{phase.archive.plugin.permissions.length === 0 ? '无' : phase.archive.plugin.permissions.join('、')}</span></div>
                    {phase.archive.plugin.missing.length > 0 && (
                      <p style={{ margin: 0, color: theme.destructive, fontSize: 13 }}>
                        缺少依赖：{phase.archive.plugin.missing.join('、')}
                      </p>
                    )}
                    {phase.archive.plugin.action === 'blocked' && (
                      <p style={{ margin: 0, color: theme.destructive, fontSize: 13 }}>
                        已安装 v{phase.archive.plugin.installed?.version}，安装包 v{phase.archive.plugin.version} 不高于已装版本，无法覆盖。
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" style={styleButton} onClick={() => setPhase({ kind: 'idle' })}>取消</button>
                    <button
                      type="button"
                      style={stylePrimary}
                      disabled={phase.archive.plugin.action === 'blocked'}
                      onClick={() => {
                        if (phase.archive.kind === 'plugin' && phase.archive.plugin.signature.state === 'unverified') {
                          setPhase({ ...phase, risk: true })
                          return
                        }
                        runInstall(phase.zipPath, phase.archive)
                      }}
                    >
                      {phase.archive.plugin.action === 'update' ? '更新' : '安装'}
                    </button>
                  </div>
                </div>
              )
      )
    : phase.kind === 'installing'
      ? <div style={{ opacity: 0.7 }}>正在安装…</div>
      : phase.kind === 'error'
        ? (
            <div style={styleCard}>
              <div style={{ color: theme.destructive, fontSize: 13, whiteSpace: 'pre-wrap' }}>{phase.message}</div>
              <div><button type="button" style={styleButton} onClick={() => setPhase({ kind: 'idle' })}>返回</button></div>
            </div>
          )
        : (
            <div style={{ width: 720, maxWidth: '94vw', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  aria-label="配置插件源"
                  style={{ ...styleButton, padding: '8px 10px', color: theme.mutedForeground }}
                  onClick={() => setFeedOpen(true)}
                >
                  ⚙
                </button>
                <input
                  value={query}
                  placeholder="本地路径 / https://… / 插件名"
                  style={styleInput}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') submitQuery() }}
                />
                <button type="button" style={styleButton} disabled={searching} onClick={submitQuery}>
                  {searching ? '搜索中…' : '搜索'}
                </button>
                <div
                  onDragOver={event => {
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={event => onDrop(event)}
                  style={{
                    padding: '8px 12px',
                    border: `1px dashed ${dragging ? theme.primary : theme.border}`,
                    borderRadius: 6,
                    fontSize: 12,
                    opacity: dragging ? 1 : 0.7,
                    whiteSpace: 'nowrap',
                  }}
                >
                  拖入 .zip 安装
                </div>
              </div>

              {message !== undefined && (
                <div style={{ fontSize: 12, color: message.kind === 'error' ? theme.destructive : 'inherit', opacity: message.kind === 'error' ? 1 : 0.75 }}>
                  {message.text}
                </div>
              )}

              {visibleResults !== undefined && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, opacity: 0.85 }}>搜索“{query.trim()}”（{searchResults?.length ?? 0}）</span>
                    <button type="button" style={{ ...styleButton, padding: '4px 10px' }} onClick={() => setSearchResults(undefined)}>✕</button>
                  </div>
                  {visibleResults.length === 0 && (
                    <div style={{ padding: '16px 0', textAlign: 'center', opacity: 0.55, fontSize: 13 }}>没有匹配的插件。</div>
                  )}
                  {visibleResults.map(item => {
                    const update = item.action === 'update' && item.installed !== undefined
                    return (
                      <div key={item.name} style={styleRow}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14 }}>
                            {item.title ?? item.name}
                            {item.source !== undefined && <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.55, border: `1px solid ${theme.border}`, borderRadius: 999, padding: '1px 8px' }}>{item.source}</span>}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>{item.name} · {item.version}</div>
                        </div>
                        {item.action === 'install'
                          ? <button type="button" style={styleButton} onClick={() => previewRemote(item)}>安装</button>
                          : update
                            ? (
                                <button
                                  type="button"
                                  style={styleVersionUpdate}
                                  title={`当前 ${item.installed?.version} → ${item.version}`}
                                  disabled={updatingName === item.name}
                                  onClick={() => requestUpdate({
                                    name: item.name,
                                    installedVersion: item.installed!.version,
                                    feedVersion: item.version,
                                  })}
                                >
                                  {updatingName === item.name ? '更新中…' : `⟳ ${item.version}`}
                                </button>
                              )
                            : <span style={{ fontSize: 12, opacity: 0.6 }}>{item.action === 'current' ? '已是最新' : '本地更新'}</span>}
                      </div>
                    )
                  })}
                  {(searchResults?.length ?? 0) > SEARCH_ROW_CAP && (
                    <div style={{ fontSize: 12, opacity: 0.55 }}>已显示前 {SEARCH_ROW_CAP} 条，共 {searchResults?.length} 条。</div>
                  )}
                </div>
              )}

              <div style={{ fontSize: 13, opacity: 0.85 }}>已安装插件（{rows.length}）</div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', gap: 6, alignContent: 'start' }}>
                {rows.length === 0
                  ? (
                      <div style={{ padding: '32px 0', textAlign: 'center', opacity: 0.55, fontSize: 14 }}>
                        暂无已安装插件
                      </div>
                    )
                  : rows.map(row => {
                      const update = updates.get(row.packageName)
                      const armed = armedUninstall === row.packageName
                      return (
                        <div key={row.name} style={styleRow}>
                          <input
                            type="checkbox"
                            aria-label={`启用 ${row.title ?? row.name}`}
                            checked={row.enabled}
                            onChange={event => toggle(row.name, event.target.checked)}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14 }}>{row.title ?? row.name}{row.category !== undefined ? `（${row.category}）` : ''}</div>
                            <div style={{ fontSize: 12, opacity: 0.6, fontFamily: 'ui-monospace, monospace' }}>{row.name}</div>
                          </div>
                          {update !== undefined
                            ? (
                                <button
                                  type="button"
                                  style={styleVersionUpdate}
                                  title={update.keyChanged === true
                                    ? `当前 ${update.installedVersion} → ${update.feedVersion} · 发布者密钥已变更`
                                    : `当前 ${update.installedVersion} → ${update.feedVersion}`}
                                  disabled={updatingName === row.packageName}
                                  onClick={() => requestUpdate(update)}
                                >
                                  {updatingName === row.packageName ? '更新中…' : `⟳ ${update.feedVersion}`}
                                </button>
                              )
                            : (
                                <span style={styleVersionIdle}>
                                  {row.version !== undefined ? `v${row.version}` : '—'}
                                </span>
                              )}
                          <button
                            type="button"
                            style={armed ? { ...styleDanger, background: 'rgba(248,81,73,.2)' } : styleDanger}
                            title="插件包与数据一并删除"
                            onClick={() => requestUninstall(row.packageName)}
                          >
                            {armed ? '确认卸载' : '卸载'}
                          </button>
                        </div>
                      )
                    })}
              </div>
            </div>
          )

  return (
    <div style={stylePage}>
      <header style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>
        <button type="button" aria-label="关闭" style={styleButton} onClick={props.onClose}>✕</button>
      </header>
      {props.notice !== undefined && (
        <div data-bootstrap-notice style={styleNotice}>{props.notice}</div>
      )}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', minHeight: 0 }}>{center}</main>
      {restartNeeded
        ? (
            <footer style={{ borderTop: `1px solid ${theme.border}`, padding: '12px 16px', display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" style={stylePrimary} onClick={() => restart()}>重启生效</button>
            </footer>
          )
        : undefined}
      {keyChange !== undefined && (
        <div style={styleOverlay} role="presentation" onClick={() => setKeyChange(undefined)}>
          <div style={styleCard} role="dialog" aria-label="发布者密钥已变更" onClick={event => event.stopPropagation()}>
            <div style={{ color: theme.warning, fontSize: 15, fontWeight: 600 }}>发布者密钥已变更</div>
            <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              <p style={{ margin: 0 }}>
                <span style={{ fontFamily: 'ui-monospace, monospace' }}>{keyChange.name}</span>
                {' '}的新版本由不同的密钥签名。
              </p>
              <p style={{ margin: 0, opacity: 0.75 }}>已安装 v{keyChange.installedVersion} → 源上 v{keyChange.feedVersion}。</p>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={styleButton} onClick={() => setKeyChange(undefined)}>取消</button>
              <button type="button" style={stylePrimary} onClick={() => updateNow(keyChange.name)}>仍要更新</button>
            </div>
          </div>
        </div>
      )}
      {feedOpen && (
        <div style={styleOverlay} role="presentation" onClick={() => setFeedOpen(false)}>
          <div style={styleCard} role="dialog" aria-label="插件源" onClick={event => event.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>插件源</div>
            <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              {feedUrls.length === 0 && <span style={{ fontSize: 12, opacity: 0.6 }}>尚未添加自定义源（当前使用出厂默认源）。</span>}
              {feedUrls.map((url, index) => (
                <div key={url} style={{ ...styleRow, padding: '6px 10px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${url}`}
                    style={{ ...styleButton, padding: '2px 8px' }}
                    onClick={() => setFeedUrls(current => current.filter((_, at) => at !== index))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={feedDraft}
                  placeholder="https://…"
                  style={{ ...styleInput, flex: 1 }}
                  onChange={event => setFeedDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') appendFeedUrl() }}
                />
                <button type="button" style={styleButton} onClick={appendFeedUrl}>添加源</button>
              </div>
            </div>
            {feedError !== undefined && <p style={{ margin: 0, color: theme.destructive, fontSize: 13 }}>{feedError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={styleButton} onClick={() => setFeedOpen(false)}>取消</button>
              <button type="button" style={stylePrimary} onClick={saveFeedUrls}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
