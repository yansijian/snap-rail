/**
 * Resident connection panel: occupies the `sidebar` slot with the live
 * connection list (status badges driven by `connection/status` frames) and,
 * while the mock driver is mounted, an offline-simulation switch. The switch
 * rewrites the driver's config through `plugins.setConfig` — the same
 * user-layer round trip an Agent or hand edit performs.
 *
 * @module @snap-rail/manage-connections
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { ConnectionSnapshot, PluginInfo } from '@snap-rail/protocol'
import { PowerOff, Power } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@snap-rail/client-ui'
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
    <Card className="mx-3 mb-3 gap-0" data-panel="connections">
      <CardHeader><CardTitle>连接</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {error !== undefined && <div className="text-xs text-destructive">{error}</div>}
        {connections.map(connection => (
          <div key={connection.id as string} className="flex items-center gap-2 text-xs">
            <Badge variant={connection.status === 'online' ? 'success' : 'destructive'}>
              {connection.status === 'online' ? '在线' : '离线'}
            </Badge>
            <span className="truncate">{connection.title}</span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">{connection.id as string}</span>
          </div>
        ))}
        {connections.length === 0 && <div className="text-xs text-muted-foreground">无连接</div>}
        {mock !== undefined && (
          <Button variant={mock.offline ? 'default' : 'outline'} size="sm" className="mt-1.5" onClick={toggleOffline}>
            {mock.offline ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
            {mock.offline ? '恢复在线' : '模拟离线'}
          </Button>
        )}
      </CardContent>
    </Card>
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
