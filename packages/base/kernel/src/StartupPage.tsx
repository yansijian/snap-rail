/**
 * The pre-plugin startup page: connect-state projection while the client
 * waits for the host handshake. Styling stays local until the theme tokens
 * arrive with the client runtime.
 *
 * @module @snap-rail/client-kernel/StartupPage
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PluginDiagnostics } from '@snap-rail/app-boot/contract'

/** Identity served by the host's `host.describe`. */
export interface HostIdentity {
  name: string
  version: string
  bin: string
}

type ConnectPhase =
  | { kind: 'connecting' }
  | { kind: 'ready'; host: HostIdentity, diagnostics?: PluginDiagnostics }
  | { kind: 'failed'; message: string }

/**
 * Render the connect lifecycle: a plain status line while connecting, the
 * host identity once ready, or the failure reason. When the boot found no
 * UI framework face, the caller passes `onInstall` to surface the corner
 * affordance back into the bootstrap install console.
 */
export function StartupPage(props: { describe: () => Promise<HostIdentity>, diagnose?: () => Promise<PluginDiagnostics>, onInstall?: () => void }): ReactNode {
  const [phase, setPhase] = useState<ConnectPhase>({ kind: 'connecting' })

  useEffect(() => {
    let alive = true
    props.describe().then(
      host => {
        if (!alive) return
        setPhase({ kind: 'ready', host })
        const diagnose = props.diagnose
        if (diagnose !== undefined) {
          void diagnose().then(diagnostics => {
            if (alive) setPhase(current => current.kind === 'ready' ? { ...current, diagnostics } : current)
          }).catch(() => undefined)
        }
      },
      cause => {
        if (alive) setPhase({ kind: 'failed', message: String(cause) })
      },
    )
    return () => {
      alive = false
    }
  }, [props])

  const line = phase.kind === 'connecting'
    ? '正在启动…'
    : phase.kind === 'ready'
      ? `${phase.host.name} ${phase.host.version}`
      : `连接失败：${phase.message}`

  const diagnostics = phase.kind === 'ready' ? phase.diagnostics : undefined

  return (
    <div className="relative flex h-screen items-center justify-center bg-background font-sans text-lg text-muted-foreground">
      {line}
      {diagnostics !== undefined && (diagnostics.missing.length > 0 || diagnostics.lastFailure !== null)
        ? (
            <div style={{ position: 'absolute', bottom: 18, maxWidth: '80%', fontSize: 12, color: '#d29922' }}>
              {diagnostics.lastFailure?.message ?? `缺少依赖：${diagnostics.missing.map(row => row.name).join('、')}`}
            </div>
          )
        : undefined}
      {props.onInstall !== undefined
        ? (
            <button
              type="button"
              onClick={props.onInstall}
              aria-label="安装插件"
              style={{ position: 'absolute', top: 12, right: 12, padding: '6px 14px', fontSize: 13, opacity: 0.7, cursor: 'pointer' }}
            >
              安装插件
            </button>
          )
        : undefined}
    </div>
  )
}
