/**
 * The ModbusTCP bridge: `modbus.*` methods over the driver's store tables.
 * Every mutation validates at the boundary (the wire schemas live in the
 * protocol), writes the `driver_modbus__*` tables transactionally, audits,
 * and emits `modbus/config-changed` — the driver reconciles per device, so
 * untouched devices keep their connections.
 *
 * @module @snap-rail/driver-modbus/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import type { GatewayService } from '@snap-rail/gateway'
import { RpcBusinessError } from '@snap-rail/protocol'
import ModbusRTU from 'modbus-serial'
import type { SettingsService } from '@snap-rail/settings'
import '@snap-rail/store'
import type { StoreHandle } from '@snap-rail/store'
import { readDocument } from './index.ts'
import { MODBUS_TABLES } from './tables.ts'

/** Settings key holding the signed-on operator (same source as station-rpc). */
const OPERATOR_KEY = 'session.operatorId'

/** The modbus bridge plugin; mount after gateway, settings, audit, and store. */
const modbusRpcPlugin: Plugin.Object<void> = {
  name: 'modbus-rpc',
  inject: ['gateway', 'audit', 'settings', 'store'],
  apply(ctx: Context): void {
    const gateway: GatewayService = ctx.gateway
    const audit: AuditService = ctx.audit
    const settings: SettingsService = ctx.settings
    const store: StoreHandle = ctx.store.register(ctx, 'driver_modbus', MODBUS_TABLES)

    const operator = (): string => settings.get<string | null>(OPERATOR_KEY) ?? 'client'

    const auditAndNotify = (action: string, subject: string): void => {
      audit.record({ actor: operator(), action, subject })
      ctx.emit('modbus/config-changed')
    }

    const notFound = (what: string): RpcBusinessError =>
      new RpcBusinessError({ code: 'not-found', details: { what } })

    gateway.registerMethod('modbus.devices.list', () => readDocument(store))

    gateway.registerMethod('modbus.devices.upsert', ({ device }) => {
      store.tx(() => {
        store.run(
          `INSERT INTO ${store.table('devices')} (id, title, host, port, unit_id, poll_ms, timeout_ms, enabled) `
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET title = excluded.title, host = excluded.host, port = excluded.port, '
          + 'unit_id = excluded.unit_id, poll_ms = excluded.poll_ms, timeout_ms = excluded.timeout_ms, enabled = excluded.enabled',
          [device.id, device.title, device.host, device.port, device.unitId, device.pollMs, device.timeoutMs, device.enabled ? 1 : 0],
        )
      })
      auditAndNotify('modbus.device.upsert', device.id)
      return { applied: true } as const
    })

    gateway.registerMethod('modbus.devices.remove', ({ id }) => {
      const removed = store.tx(() => {
        const existing = store.get(`SELECT id FROM ${store.table('devices')} WHERE id = ?`, [id])
        if (existing === undefined) return false
        store.run(`DELETE FROM ${store.table('devices')} WHERE id = ?`, [id])
        store.run(`DELETE FROM ${store.table('points')} WHERE device_id = ?`, [id])
        return true
      })
      if (!removed) throw notFound(`unknown device: ${id}`)
      auditAndNotify('modbus.device.remove', id)
      return { applied: true } as const
    })

    gateway.registerMethod('modbus.devices.test', async ({ device }) => {
      const client = new ModbusRTU()
      try {
        await client.connectTCP(device.host, { port: device.port })
        client.setID(device.unitId)
        client.setTimeout(device.timeoutMs)
        // A minimal register read proves the unit answers, not just the socket.
        await client.readHoldingRegisters(0, 1)
        return { ok: true } as const
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      } finally {
        try {
          if (client.isOpen) client.close(() => {})
        } catch {
          // Test client disposal is best-effort.
        }
      }
    })

    gateway.registerMethod('modbus.vars.upsert', ({ name, type }) => {
      store.run(
        `INSERT INTO ${store.table('vars')} (name, type) VALUES (?, ?) `
        + 'ON CONFLICT(name) DO UPDATE SET type = excluded.type',
        [name, type],
      )
      auditAndNotify('modbus.var.upsert', name)
      return { applied: true } as const
    })

    gateway.registerMethod('modbus.vars.remove', ({ name }) => {
      store.tx(() => {
        store.run(`DELETE FROM ${store.table('vars')} WHERE name = ?`, [name])
        store.run(`DELETE FROM ${store.table('points')} WHERE var = ?`, [name])
      })
      auditAndNotify('modbus.var.remove', name)
      return { applied: true } as const
    })

    gateway.registerMethod('modbus.points.upsert', ({ point }) => {
      const device = store.get(`SELECT id FROM ${store.table('devices')} WHERE id = ?`, [point.deviceId])
      if (device === undefined) throw notFound(`unknown device: ${point.deviceId}`)
      store.run(
        `INSERT INTO ${store.table('points')} (var, device_id, type, fc, address, encoding, byte_order, scale, writable, deadband) `
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(var) DO UPDATE SET device_id = excluded.device_id, type = excluded.type, fc = excluded.fc, '
        + 'address = excluded.address, encoding = excluded.encoding, byte_order = excluded.byte_order, '
        + 'scale = excluded.scale, writable = excluded.writable, deadband = excluded.deadband',
        [point.var, point.deviceId, point.type, point.fc, point.address, point.encoding, point.byteOrder,
          point.scale ?? null, point.writable ? 1 : 0, point.deadband ?? null],
      )
      auditAndNotify('modbus.point.upsert', point.var)
      return { applied: true } as const
    })

    gateway.registerMethod('modbus.points.remove', ({ id }) => {
      store.run(`DELETE FROM ${store.table('points')} WHERE var = ?`, [id])
      auditAndNotify('modbus.point.remove', id)
      return { applied: true } as const
    })
  },
}

export default modbusRpcPlugin
