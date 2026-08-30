/**
 * The pre-plugin startup page: connect-state projection while the client
 * waits for the host handshake. Styling stays local until the theme tokens
 * arrive with the client runtime.
 *
 * @module @snap-rail/client-kernel/StartupPage
 */

import { useEffect, useState, type ReactNode } from 'react'

/** Identity served by the host's `host.describe`. */
export interface HostIdentity {
  name: string
  version: string
  bin: string
}

type ConnectPhase =
  | { kind: 'connecting' }
  | { kind: 'ready'; host: HostIdentity }
  | { kind: 'failed'; message: string }

/**
 * Render the connect lifecycle: a plain status line while connecting, the
 * host identity once ready, or the failure reason.
 */
export function StartupPage(props: { describe: () => Promise<HostIdentity> }): ReactNode {
  const [phase, setPhase] = useState<ConnectPhase>({ kind: 'connecting' })

  useEffect(() => {
    let alive = true
    props.describe().then(
      host => {
        if (alive) setPhase({ kind: 'ready', host })
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
    ? '正在连接宿主…'
    : phase.kind === 'ready'
      ? `${phase.host.name} ${phase.host.version}`
      : `连接失败：${phase.message}`

  return (
    <div className="flex h-screen items-center justify-center bg-background font-sans text-lg text-muted-foreground">
      {line}
    </div>
  )
}
