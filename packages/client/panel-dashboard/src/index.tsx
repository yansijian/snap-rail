/**
 * Resident live dashboard: occupies the `view` slot with one card per field
 * point, fed by a points.list snapshot plus point/updated and
 * connection/status streams over the shared host link. `null` values render
 * as the abnormal marker instead of guessing.
 *
 * @module @snap-rail/panel-dashboard
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import { useEffect, useState, type ReactNode } from 'react'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

interface CellState {
  value: unknown
  /** Connection status the point belongs to. */
  status: 'online' | 'offline'
}

function formatValue(value: unknown): string {
  if (value === null) return '— 异常'
  if (typeof value === 'bigint') return `${value}`
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  return String(value)
}

const cardStyle = {
  background: 'var(--sr-panel)',
  borderRadius: 'var(--sr-radius)',
  border: '1px solid var(--sr-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  margin: 'var(--sr-space)',
  padding: 'calc(var(--sr-space) * 1.5)',
} as const

function Grid(props: { cells: [string, CellState][] }): ReactNode {
  const allOnline = props.cells.every(([, cell]) => cell.status === 'online')
  return (
    <div style={{ overflow: 'auto', padding: 'var(--sr-space)' }}>
      {!allOnline && (
        <div style={{ color: 'var(--sr-bad)', margin: 'var(--sr-space)' }}>有连接离线</div>
      )}
      {props.cells.map(([id, cell]) => (
        <div key={id} className="sr-card" style={cardStyle}>
          <span>
            <span style={{ color: cell.status === 'online' ? 'var(--sr-ok)' : 'var(--sr-bad)', marginRight: 6 }}>
              {cell.status === 'online' ? '●' : '○'}
            </span>
            {id}
          </span>
          <span style={cell.value === null ? { color: 'var(--sr-bad)' } : undefined}>
            {formatValue(cell.value)}
          </span>
        </div>
      ))}
      {props.cells.length === 0 && <div style={{ color: 'var(--sr-text-dim)', margin: 'var(--sr-space)' }}>点表为空</div>}
    </div>
  )
}

function Dashboard(props: { link: HostLink }): ReactNode {
  const [cells, setCells] = useState<Map<string, CellState>>(new Map())

  useEffect(() => {
    let alive = true
    const detachers: Array<() => void> = []
    void (async () => {
      const list = await props.link.call('points.list', {})
      const conns = await props.link.call('connections.list', {})
      if (!alive || !list.ok || !conns.ok) return
      const statusById = new Map(conns.value.connections.map(connection => [connection.id as string, connection.status]))
      setCells(new Map(list.value.points.map(point => [
        point.id as string,
        { value: null, status: statusById.get(point.connection as string) ?? 'offline' },
      ])))

      // Server-side subscription first: the bridge pumps value frames only
      // for ids requested through points.subscribe.
      const ids = list.value.points.map(point => point.id as string)
      if (ids.length > 0) await props.link.call('points.subscribe', { ids }).catch(() => {})
      detachers.push(() => {
        void props.link.call('points.unsubscribe', { ids }).catch(() => {})
      })

      detachers.push(props.link.subscribe('point/updated', payload => {
        const frame = payload as { id: string, value: unknown }
        setCells(previous => {
          const next = new Map(previous)
          const cell = next.get(frame.id)
          if (cell !== undefined) next.set(frame.id, { ...cell, value: frame.value })
          return next
        })
      }))
      detachers.push(props.link.subscribe('connection/status', payload => {
        const frame = payload as { id: string, status: 'online' | 'offline' }
        setCells(previous => {
          const next = new Map(previous)
          for (const [id, cell] of previous) {
            if (id.startsWith(`${frame.id}.`)) next.set(id, { ...cell, status: frame.status })
          }
          return next
        })
      }))
    })()
    return () => {
      alive = false
      for (const detach of detachers.splice(0)) detach()
    }
  }, [props.link])

  return <Grid cells={[...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1))} />
}

/** The dashboard occupant. */
const dashboardPlugin: Plugin.Object<void> = {
  name: 'panel-dashboard',
  inject: ['uiSlots', 'client'],
  apply(ctx: Context): void {
    ctx.uiSlots.register(ctx, 'view', {
      id: 'dashboard',
      order: 0,
      render(): ReactNode {
        return <Dashboard link={ctx.client.link} />
      },
    })
  },
}

export default dashboardPlugin
