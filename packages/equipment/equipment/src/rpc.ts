/**
 * The equipment seam's rpc bridge: claims the `equipment` wire domain and
 * serves the whole contract in one call — the point-table methods, the
 * configuration CRUD, and the driver-registry/generic-mapping faces, with
 * every schema riding the `./wire` declaration. Equipment events pump into
 * `equipment/*` broadcast frames; `equipment/point-updated` frames flow
 * while at least one subscription reference holds the point's address —
 * references are counted (a renderer often holds several consumers of one
 * address; the last unsubscribe, not any unsubscribe, stops the frames), so
 * one consumer unmounting never starves the rest. A renderer reload that
 * skips its unsubscribes leaks counts — wasted broadcasts only, never lost
 * ones. Structural frames (added/removed, status) always flow so lists stay
 * current.
 *
 * @module @snap-rail/equipment/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import type { GatewayService } from '@snap-rail/gateway'
import { RpcBusinessError } from '@snap-rail/protocol'
import { EquipmentError, pointKey } from './index.ts'
import type { ConnectionsService, EquipmentService, PointsService } from './index.ts'
import { equipmentContract } from './wire.ts'

/** The equipment-rpc bridge plugin; mount after rpc, equipment, and audit. */
const equipmentRpcPlugin: Plugin.Object = {
  name: 'equipment-rpc',
  inject: ['rpc', 'points', 'connections', 'equipment', 'audit'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const points: PointsService = ctx.points
    const connections: ConnectionsService = ctx.connections
    const equipment: EquipmentService = ctx.equipment
    const audit: AuditService = ctx.audit
    /** Reference count per composite point key; frames flow above zero. */
    const refcounts = new Map<string, number>()
    /** Run a config mutation, translating seam failures to wire errors. */
    const attempt = <T>(what: string, fn: () => T): T => {
      try {
        return fn()
      } catch (cause) {
        throw mapConfigError(what, cause)
      }
    }

    rpc.claimDomain(ctx, 'equipment')

    rpc.serveContract(ctx, equipmentContract, {
      'equipment.points.list': () => ({
        points: points.list(),
      }),

      'equipment.points.read': ({ points: wanted }) => {
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
      },

      'equipment.points.write': async ({ point, value }) => {
        try {
          await points.write(point, value)
        } catch (cause) {
          throw mapWriteError(pointKey(point), value, cause)
        }
        audit.record({ actor: 'client', action: 'equipment.point.write', subject: pointKey(point), detail: { value } })
        return { accepted: true } as const
      },

      'equipment.points.subscribe': ({ points: refs }) => {
        for (const ref of refs) {
          const key = pointKey(ref)
          refcounts.set(key, (refcounts.get(key) ?? 0) + 1)
        }
        return { subscribed: true } as const
      },

      'equipment.points.unsubscribe': ({ points: refs }) => {
        for (const ref of refs) {
          const key = pointKey(ref)
          const next = Math.max(0, (refcounts.get(key) ?? 0) - 1)
          if (next === 0) refcounts.delete(key)
          else refcounts.set(key, next)
        }
        return { unsubscribed: true } as const
      },

      'equipment.connections.list': () => ({
        connections: connections.list(),
      }),

      'equipment.config.list': () => ({
        config: attempt('config read', () => equipment.config()),
      }),

      'equipment.devices.upsert': ({ device }) => {
        const saved = attempt('device upsert', () => equipment.upsertDevice(device))
        audit.record({
          actor: 'client',
          action: 'equipment.device.upsert',
          subject: saved.id,
          detail: { name: saved.name, driver: saved.driver },
        })
        return { device: saved }
      },

      'equipment.devices.test': async ({ driver, config, read }) => {
        try {
          return { result: await equipment.testDevice({ driver, config, ...(read !== undefined ? { read } : {}) }) }
        } catch (cause) {
          throw mapConfigError('device test', cause)
        }
      },

      'equipment.devices.remove': ({ id }) => {
        attempt('device remove', () => equipment.removeDevice(id))
        audit.record({ actor: 'client', action: 'equipment.device.remove', subject: id })
        return { removed: true } as const
      },

      'equipment.groups.upsert': ({ device, group }) => {
        const saved = attempt('group upsert', () => equipment.upsertGroup(device, group))
        audit.record({
          actor: 'client',
          action: 'equipment.group.upsert',
          subject: `${device}/${group.name}`,
          detail: { type: group.type },
        })
        return { group: saved }
      },

      'equipment.groups.remove': ({ device, group }) => {
        attempt('group remove', () => equipment.removeGroup(device, group))
        audit.record({ actor: 'client', action: 'equipment.group.remove', subject: `${device}/${group}` })
        return { removed: true } as const
      },

      'equipment.points.upsert': ({ device, group, point }) => {
        const saved = attempt('point upsert', () => equipment.upsertPoint(device, group, point))
        audit.record({
          actor: 'client',
          action: 'equipment.point.upsert',
          subject: `${device}/${group}/${point.name}`,
        })
        return { point: saved }
      },

      'equipment.points.remove': payload => {
        attempt('point remove', () => equipment.removePoint({
          device: payload.device,
          group: payload.group,
          name: payload.name,
        }))
        audit.record({
          actor: 'client',
          action: 'equipment.point.remove',
          subject: `${payload.device}/${payload.group}/${payload.name}`,
        })
        return { removed: true } as const
      },

      'equipment.drivers.list': () => ({
        drivers: equipment.listDrivers(),
      }),

      'equipment.mappings.list': () => ({
        mappings: attempt('mappings read', () => equipment.mappings()),
      }),
    })

    ctx.on('point/updated', sample => {
      if ((refcounts.get(pointKey(sample)) ?? 0) > 0) {
        const { device, group, name, value, time } = sample
        rpc.broadcast('equipment/point-updated', { device, group, name, value, time })
      }
    })
    rpc.bridgeEvent(ctx, 'point/added', 'equipment/point-added', point => ({ point }))
    rpc.bridgeEvent(ctx, 'point/removed', 'equipment/point-removed', ref => ({ device: ref.device, group: ref.group, name: ref.name }))
    rpc.bridgeEvent(ctx, 'connection/added', 'equipment/connection-added', connection => ({ connection }))
    rpc.bridgeEvent(ctx, 'connection/removed', 'equipment/connection-removed', id => ({ id }))
    rpc.bridgeEvent(ctx, 'connection/status', 'equipment/connection-status', frame => frame)
    rpc.bridgeEvent(ctx, 'equipment/mappings-changed', 'equipment/mappings-changed', () => ({}))
    rpc.bridgeEvent(ctx, 'equipment/structure-changed', 'equipment/structure-changed', () => ({}))
  },
}

/**
 * EquipmentError check that survives dual module identity: the renderer-side
 * tests assemble the host world through a different module graph than the
 * running app, so `instanceof` alone would map a genuine seam failure to
 * bare `internal`. The error carries its own name and machine-readable kind —
 * check those too.
 */
function isEquipmentError(cause: unknown): cause is EquipmentError {
  return cause instanceof EquipmentError
    || (typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'EquipmentError'
      && typeof (cause as EquipmentError).kind === 'string')
}

function mapConfigError(what: string, cause: unknown): RpcBusinessError {
  if (isEquipmentError(cause)) {
    switch (cause.kind) {
      case 'unknown-device':
      case 'unknown-group':
      case 'unknown-driver':
      case 'unknown-point':
        return new RpcBusinessError({ code: 'not-found', details: { what: cause.message } })
      case 'invalid-config':
        return new RpcBusinessError({ code: 'bad-request', details: { issues: [cause.message] } })
      case 'no-probe':
        return new RpcBusinessError({ code: 'unavailable', details: { what: cause.message } })
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
  return new RpcBusinessError({ code: 'internal', details: { hint: `equipment ${what} failed` } })
}

function mapWriteError(key: string, value: unknown, cause: unknown): RpcBusinessError {
  if (isEquipmentError(cause)) {
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

export default equipmentRpcPlugin
