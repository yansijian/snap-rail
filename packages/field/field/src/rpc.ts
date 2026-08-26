/**
 * The field seam's gateway bridge: registers the points/connections methods
 * and pumps field events into broadcast frames. `point/updated` frames flow
 * only for ids a client subscribed to; structural frames (added/removed,
 * status) always flow so lists stay current.
 *
 * @module @snap-rail/field/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import { RpcBusinessError, PointId } from '@snap-rail/protocol'
import { FieldError } from './index.ts'
import type { PointsService, ConnectionsService } from './index.ts'
import type { AuditService } from '@snap-rail/audit'

/** The field-rpc bridge plugin; mount after gateway, field, and audit. */
const fieldRpcPlugin: Plugin.Object = {
  name: 'field-rpc',
  inject: ['gateway', 'points', 'connections', 'audit'],
  apply(ctx: Context): void {
    const gateway: GatewayService = ctx.gateway
    const points: PointsService = ctx.points
    const connections: ConnectionsService = ctx.connections
    const audit: AuditService = ctx.audit
    const subscribed = new Set<string>()

    gateway.registerMethod('points.list', () => ({ points: points.list() }))

    gateway.registerMethod('points.read', ({ ids }) => {
      const known = new Set(points.list().map(point => point.id as string))
      const unknown = ids.filter(id => !known.has(id))
      if (unknown.length > 0) {
        throw new RpcBusinessError({ code: 'not-found', details: { what: `unknown points: ${unknown.join(', ')}` } })
      }
      // A registered point without its first sample reads as `null` (point
      // abnormal): `time` 0 marks "no observation yet".
      return { samples: ids.map(id => points.read(PointId(id)) ?? { id: PointId(id), value: null, time: 0 }) }
    })

    gateway.registerMethod('points.write', async ({ id, value }) => {
      try {
        await points.write(PointId(id), value)
      } catch (cause) {
        throw mapWriteError(id, value, cause)
      }
      audit.record({ actor: 'client', action: 'point.write', subject: id, detail: { value } })
      return { accepted: true } as const
    })

    gateway.registerMethod('points.subscribe', ({ ids }) => {
      for (const id of ids) subscribed.add(id)
      return { subscribed: true } as const
    })

    gateway.registerMethod('points.unsubscribe', ({ ids }) => {
      for (const id of ids) subscribed.delete(id)
      return { unsubscribed: true } as const
    })

    gateway.registerMethod('connections.list', () => ({ connections: connections.list() }))

    ctx.on('point/added', point => gateway.broadcast('point/added', { point }))
    ctx.on('point/removed', id => gateway.broadcast('point/removed', { id }))
    ctx.on('point/updated', sample => {
      if (subscribed.has(sample.id)) {
        gateway.broadcast('point/updated', { id: sample.id, value: sample.value, time: sample.time })
      }
    })
    ctx.on('connection/added', connection => gateway.broadcast('connection/added', { connection }))
    ctx.on('connection/removed', id => gateway.broadcast('connection/removed', { id }))
    ctx.on('connection/status', frame => gateway.broadcast('connection/status', frame))
  },
}

function mapWriteError(id: string, value: unknown, cause: unknown): RpcBusinessError {
  if (cause instanceof FieldError) {
    switch (cause.kind) {
      case 'unknown-point':
        return new RpcBusinessError({ code: 'not-found', details: { what: `unknown point: ${id}` } })
      case 'type-mismatch':
        return new RpcBusinessError({ code: 'bad-request', details: { issues: [cause.message] } })
      case 'no-write-handler':
        return new RpcBusinessError({ code: 'unavailable', details: { what: `point ${id} is not writable` } })
      case 'duplicate-connection':
      case 'duplicate-point':
        break
    }
  }
  return new RpcBusinessError({ code: 'internal', details: { hint: `write to ${id} failed: ${String(value)}` } })
}

export default fieldRpcPlugin
