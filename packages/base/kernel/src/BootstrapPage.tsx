/**
 * The no-framework recovery console: when no UI framework face is enabled,
 * this page is the terminal's whole interface — a blank canvas with a close
 * button top-right and a center hint to drag a plugin zip in. Installing,
 * enabling, and restarting all ride the regular `plugins.*` wire methods,
 * so the bootstrap page is a client of the very pipeline it bootstraps.
 * Styling stays local by design: theme tokens arrive only with a framework.
 *
 * @module @snap-rail/client-kernel/BootstrapPage
 */

import { useCallback, useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { HostLink } from '@snap-rail/connection'
import type { RpcError } from '@snap-rail/protocol'
import type { InspectedPlugin, PluginInfo } from '@snap-rail/app-boot/contract'
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
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  | { kind: 'confirm'; zipPath: string; plugin: InspectedPlugin }
  | { kind: 'installing'; zipPath: string }
  | { kind: 'error'; message: string }

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

/** Render the recovery console. See {@link BootstrapPageProps}. */
export function BootstrapPage(props: BootstrapPageProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [rows, setRows] = useState<readonly PluginInfo[]>([])
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void props.link.call('plugins.list', {}).then(result => {
      if (result.ok) setRows(result.value.plugins.filter(row => row.source === 'pool'))
    })
  }, [props.link])

  useEffect(refresh, [refresh])

  const fail = (message: string): void => {
    setBusy(false)
    setPhase({ kind: 'error', message })
  }

  const onDrop = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file === undefined) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setPhase({ kind: 'error', message: '只支持 .zip 插件包' })
      return
    }
    const zipPath = props.zipPathOf(file)
    if (zipPath === null) {
      setPhase({ kind: 'error', message: '当前环境不支持拖拽安装（缺少路径桥）' })
      return
    }
    setPhase({ kind: 'inspecting' })
    const result = await props.link.call('plugins.inspect', { zipPath })
    if (!result.ok) {
      fail(`读取插件包失败：${errorText(result.error)}`)
      return
    }
    setPhase({ kind: 'confirm', zipPath, plugin: result.value.plugin })
  }

  const install = async (zipPath: string): Promise<void> => {
    setPhase({ kind: 'installing', zipPath })
    const result = await props.link.call('plugins.install', { zipPath })
    if (!result.ok) {
      fail(`安装失败：${errorText(result.error)}`)
      return
    }
    setPhase({ kind: 'idle' })
    setRestartNeeded(true)
    refresh()
  }

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    setBusy(true)
    const result = await props.link.call('plugins.set-enabled', { name, enabled })
    setBusy(false)
    if (!result.ok) {
      setPhase({ kind: 'error', message: errorText(result.error) })
      return
    }
    setRestartNeeded(true)
    refresh()
  }

  const restart = async (): Promise<void> => {
    await props.link.call('window.relaunch', {})
  }

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
    : phase.kind === 'inspecting' || phase.kind === 'installing'
      ? <div style={{ opacity: 0.7 }}>{phase.kind === 'inspecting' ? '正在读取插件包…' : '正在安装…'}</div>
      : phase.kind === 'error'
        ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ color: '#f87171' }}>{phase.message}</div>
              <button type="button" style={styleButton} onClick={() => setPhase({ kind: 'idle' })}>返回</button>
            </div>
          )
        : (
            <div
              onDragOver={event => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => void onDrop(event)}
              style={{
                padding: '48px 64px',
                border: `2px dashed ${dragging ? '#2563eb' : '#3a4048'}`,
                borderRadius: 12,
                background: dragging ? '#141a22' : 'transparent',
                fontSize: 16,
                transition: 'border-color .15s, background .15s',
              }}
            >
              拖拽插件包（.zip）到此处安装
            </div>
          )

  return (
    <div style={stylePage}>
      <header style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}>
        <button type="button" aria-label="关闭" style={styleButton} onClick={props.onClose}>✕</button>
      </header>
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{center}</main>
      {rows.length > 0
        ? (
            <footer style={{ borderTop: '1px solid #23282e', padding: '12px 16px', display: 'grid', gap: 8 }}>
              {rows.map(row => (
                <label key={row.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={busy}
                    onChange={event => void toggle(row.name, event.target.checked)}
                  />
                  <span>
                    {row.title ?? row.name}
                    {row.category !== undefined ? `（${row.category}）` : ''}
                  </span>
                </label>
              ))}
              {restartNeeded
                ? (
                    <button type="button" style={stylePrimary} onClick={() => void restart()}>
                      重启生效
                    </button>
                  )
                : undefined}
            </footer>
          )
        : undefined}
    </div>
  )
}
