/**
 * The field seam's rpc bridge: claims the `field` wire domain and registers
 * the point-table methods with their schemas, plus the driver-registry and
 * generic-mapping faces. The domain's push face rides topics declared and
 * published by the field base itself (`field/*` — see `wire.ts`), so this
 * bridge carries no event forwarding: consumers subscribe through the topic
 * primitive.
 *
 * @module @snap-rail/field/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import type { GatewayService } from '@snap-rail/gateway'
import { RpcBusinessError } from '@snap-rail/protocol'
import { FieldError, pointKey } from './index.ts'
import type { ConnectionsService, FieldService, PointsService } from './index.ts'
import { fieldRequestSchemas } from './wire.ts'

/** The field-rpc bridge plugin; mount after rpc, field, and audit. */
const fieldRpcPlugin: Plugin.Object = {
  name: 'field-rpc',
  inject: ['rpc', 'points', 'connections', 'field', 'audit'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const points: PointsService = ctx.points
    const connections: ConnectionsService = ctx.connections
    const field: FieldService = ctx.field
    const audit: AuditService = ctx.audit
    /** Run a config mutation, translating seam failures to wire errors. */
    const attempt = <T>(what: string, fn: () => T): T => {
      try {
        return fn()
      } catch (cause) {
        throw mapConfigError(what, cause)
      }
    }

    rpc.claimDomain(ctx, 'field')

    rpc.method(ctx, 'field.points.list', { request: fieldRequestSchemas['field.points.list'] }, () => ({
      points: points.list(),
    }))

    rpc.method(ctx, 'field.points.read', { request: fieldRequestSchemas['field.points.read'] }, ({ points: wanted }) => {
      const known = new Set(points.list().map(point => pointKey(point)))
      const unknown = wanted.filter(ref => !known.has(pointKey(ref)))
      if (unknown.length > 0) {
        const what = unknown.map(ref => pointKey(ref)).join(', ')
        throw new RpcBusinessError({ code: 'not-found', details: { what: `unknown points: ${what}` } })
      }
      // A registered point without its first sample reads as `null` (point
      // abnormal): `time` 0 marks "no observation yet".
      return {
        samples: wanted.map(ref => points.read(ref)
          ?? { device: ref.device, group: ref.group, name: ref.name, value: null, time: 0 }),
      }
    })

    rpc.method(ctx, 'field.points.write', { request: fieldRequestSchemas['field.points.write'] }, async ({ point, value }) => {
      try {
        await points.write(point, value)
      } catch (cause) {
        throw mapWriteError(pointKey(point), value, cause)
      }
      audit.record({ actor: 'client', action: 'field.point.write', subject: pointKey(point), detail: { value } })
      return { accepted: true } as const
    })

    rpc.method(ctx, 'field.connections.list', { request: fieldRequestSchemas['field.connections.list'] }, () => ({
      connections: connections.list(),
    }))

    rpc.method(ctx, 'field.config.list', { request: fieldRequestSchemas['field.config.list'] }, () => ({
      config: attempt('config read', () => field.config()),
    }))

    rpc.method(ctx, 'field.devices.upsert', { request: fieldRequestSchemas['field.devices.upsert'] }, ({ device }) => {
      const saved = attempt('device upsert', () => field.upsertDevice(device))
      audit.record({
        actor: 'client',
        action: 'field.device.upsert',
        subject: saved.id,
        detail: { name: saved.name, driver: saved.driver },
      })
      return { device: saved }
    })

    rpc.method(ctx, 'field.devices.remove', { request: fieldRequestSchemas['field.devices.remove'] }, ({ id }) => {
      attempt('device remove', () => field.removeDevice(id))
      audit.record({ actor: 'client', action: 'field.device.remove', subject: id })
      return { removed: true } as const
    })

    rpc.method(ctx, 'field.groups.upsert', { request: fieldRequestSchemas['field.groups.upsert'] }, ({ device, group }) => {
      const saved = attempt('group upsert', () => field.upsertGroup(device, group))
      audit.record({
        actor: 'client',
        action: 'field.group.upsert',
        subject: `${device}/${group.name}`,
        detail: { type: group.type },
      })
      return { group: saved }
    })

    rpc.method(ctx, 'field.groups.remove', { request: fieldRequestSchemas['field.groups.remove'] }, ({ device, group }) => {
      attempt('group remove', () => field.removeGroup(device, group))
      audit.record({ actor: 'client', action: 'field.group.remove', subject: `${device}/${group}` })
      return { removed: true } as const
    })

    rpc.method(ctx, 'field.points.upsert', { request: fieldRequestSchemas['field.points.upsert'] }, ({ device, group, point }) => {
      const saved = attempt('point upsert', () => field.upsertPoint(device, group, point))
      audit.record({
        actor: 'client',
        action: 'field.point.upsert',
        subject: `${device}/${group}/${point.name}`,
      })
      return { point: saved }
    })

    rpc.method(ctx, 'field.points.remove', { request: fieldRequestSchemas['field.points.remove'] }, payload => {
      attempt('point remove', () => field.removePoint({
        device: payload.device,
        group: payload.group,
        name: payload.name,
      }))
      audit.record({
        actor: 'client',
        action: 'field.point.remove',
        subject: `${payload.device}/${payload.group}/${payload.name}`,
      })
      return { removed: true } as const
    })

    rpc.method(ctx, 'field.drivers.list', { request: fieldRequestSchemas['field.drivers.list'] }, () => ({
      drivers: field.listDrivers(),
    }))

    rpc.method(ctx, 'field.mappings.list', { request: fieldRequestSchemas['field.mappings.list'] }, () => ({
      mappings: attempt('mappings read', () => field.mappings()),
    }))
  },
}

function mapConfigError(what: string, cause: unknown): RpcBusinessError {
  if (cause instanceof FieldError) {
    switch (cause.kind) {
      case 'unknown-device':
      case 'unknown-group':
      case 'unknown-driver':
      case 'unknown-point':
        return new RpcBusinessError({ code: 'not-found', details: { what: cause.message } })
      case 'invalid-config':
        return new RpcBusinessError({ code: 'bad-request', details: { issues: [cause.message] } })
      case 'type-conflict':
      case 'driver-conflict':
      // Registry collisions (a live connection/point re-registering) are
      // consistency failures the operator can act on, not internal ones.
      case 'duplicate-connection':
      case 'duplicate-point':
      case 'duplicate-driver':
        return new RpcBusinessError({ code: 'conflict', details: { what: cause.message } })
    }
  }
  return new RpcBusinessError({ code: 'internal', details: { hint: `field ${what} failed` } })
}

function mapWriteError(key: string, value: unknown, cause: unknown): RpcBusinessError {
  if (cause instanceof FieldError) {
    switch (cause.kind) {
      case 'unknown-point':
        return new RpcBusinessError({ code: 'not-found', details: { what: `unknown point: ${key}` } })
      case 'type-mismatch':
        return new RpcBusinessError({ code: 'bad-request', details: { issues: [cause.message] } })
      case 'no-write-handler':
        return new RpcBusinessError({ code: 'unavailable', details: { what: `point ${key} is not writable` } })
      case 'duplicate-connection':
      case 'duplicate-point':
      case 'duplicate-driver':
        break
    }
  }
  return new RpcBusinessError({ code: 'internal', details: { hint: `write to ${key} failed: ${String(value)}` } })
}

export default fieldRpcPlugin
