/**
 * Resident connection panel: occupies the `sidebar` slot with the live
 * connection list (status dots driven by `connection/status` frames) and,
 * while the mock driver is mounted, an offline-simulation toggle. The toggle
 * rewrites the driver's config through `plugins.setConfig` — the same
 * user-layer round trip an Agent or hand edit performs.
 *
 * @module @snap-rail/manage-connections
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { ConnectionSnapshot, PluginInfo } from '@snap-rail/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

/** The mock driver's package name; the only phase-1 offline-simulatable source. */
const MOCK_DRIVER = '@snap-rail/driver-mock'

interface MockDriverConfig {
  connection: string
  title: string
  offline: boolean
  periodMs: number
  points: Array<{ id: string, type: string }>
}

const toggleStyle = {
  background: 'transparent',
  border: '1px solid var(--sr-border)',
  borderRadius: 'var(--sr-radius)',
  color: 'var(--sr-text)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 8px',
} as const

function ConnectionsPanel(props: { link: HostLink }): ReactNode {
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([])
  const [mock, setMock] = useState<MockDriverConfig | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const detachers: Array<() => void> = []
    void (async () => {
      const listed = await props.link.call('connections.list', {})
      if (!alive || !listed.ok) {
        if (!listed.ok) setError(`连接列表加载失败（${listed.error.code}）`)
        return
      }
      setConnections([...listed.value.connections])

      const plugins = await props.link.call('plugins.list', {})
      if (!alive || !plugins.ok) return
      const driver = plugins.value.plugins.find(
        (plugin: PluginInfo) => plugin.name === MOCK_DRIVER && plugin.enabled && plugin.config !== undefined,
      )
      if (driver !== undefined) setMock(driver.config as MockDriverConfig)

      detachers.push(props.link.subscribe('connection/status', payload => {
        const frame = payload as { id: string, status: 'online' | 'offline' }
        setConnections(previous => previous.map(connection =>
          connection.id === (frame.id as typeof connection.id)
            ? { ...connection, status: frame.status }
            : connection,
        ))
      }))
    })()
    return () => {
      alive = false
      for (const detach of detachers.splice(0)) detach()
    }
  }, [props.link])

  const toggleOffline = (): void => {
    if (mock === undefined) return
    const next = { ...mock, offline: !mock.offline }
    setMock(next)
    void props.link.call('plugins.setConfig', { name: MOCK_DRIVER, config: next }).then(result => {
      if (!result.ok) {
        setError(`离线模拟失败（${result.error.code}）`)
        setMock(mock)
      }
    })
  }

  return (
    <section data-panel="connections" style={{ padding: 'var(--sr-space)', borderTop: '1px solid var(--sr-border)' }}>
      <h3 style={{ fontSize: 12, margin: '0 0 6px', color: 'var(--sr-text-dim)' }}>连接</h3>
      {error !== undefined && <div style={{ color: 'var(--sr-bad)', fontSize: 12 }}>{error}</div>}
      {connections.map(connection => (
        <div key={connection.id as string} style={{ alignItems: 'center', display: 'flex', gap: 6, padding: '4px 0' }}>
          <span style={{ color: connection.status === 'online' ? 'var(--sr-ok)' : 'var(--sr-bad)' }}>
            {connection.status === 'online' ? '●' : '○'}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {connection.title}
          </span>
          <span style={{ color: 'var(--sr-text-dim)', fontSize: 11 }}>{connection.id as string}</span>
        </div>
      ))}
      {connections.length === 0 && <div style={{ color: 'var(--sr-text-dim)', fontSize: 12 }}>无连接</div>}
      {mock !== undefined && (
        <button type="button" style={{ ...toggleStyle, marginTop: 6 }} onClick={toggleOffline}>
          {mock.offline ? '恢复在线' : '模拟离线'}
        </button>
      )}
    </section>
  )
}

/** The connection management occupant. */
const manageConnectionsPlugin: Plugin.Object<void> = {
  name: 'manage-connections',
  inject: ['uiSlots', 'client'],
  apply(ctx: Context): void {
    ctx.uiSlots.register(ctx, 'sidebar', {
      id: 'manage-connections',
      order: 20,
      render(): ReactNode {
        return <ConnectionsPanel link={ctx.client.link} />
      },
    })
  },
}

export default manageConnectionsPlugin
