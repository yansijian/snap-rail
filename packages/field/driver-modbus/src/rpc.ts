/**
 * The ModbusTCP bridge: registers the driver under the field domain's
 * `field.modbus.*` sub-namespace (claimed here, with schemas from the
 * `./contract` module) and registers the driver identity + mapping
 * projection with the field seam. Every mutation validates at the boundary,
 * writes the `driver_modbus__*` tables transactionally, audits, and emits
 * `modbus/config-changed` (host) plus `field/modbus-config-changed`
 * (renderer) and `field/mappings-changed` (bindings re-resolve) — the
 * driver reconciles per device, so untouched devices keep their connections.
 *
 * @module @snap-rail/driver-modbus/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import type { FieldService } from '@snap-rail/field'
import type { GatewayService } from '@snap-rail/gateway'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { SettingsService } from '@snap-rail/settings'
import '@snap-rail/store'
import type { StoreHandle } from '@snap-rail/store'
import { modbusConfigChangedSchema, modbusRequestSchemas } from './contract.ts'
import { probeDevice } from './probe.ts'
import { projectMapping, readDocument } from './document.ts'
import { SESSION_OPERATOR_KEY } from '@snap-rail/station-rpc/contract'
import { MODBUS_TABLES } from './tables.ts'

/** The modbus bridge plugin; mounted as a child of the root driver entry,
 * whose inject union guarantees rpc, field, settings, audit, and store are
 * up before this fiber starts. */
const modbusRpcPlugin: Plugin.Object<void> = {
  name: 'modbus-rpc',
  inject: ['rpc', 'field', 'audit', 'settings', 'store'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const field: FieldService = ctx.field
    const audit: AuditService = ctx.audit
    const settings: SettingsService = ctx.settings
    const store: StoreHandle = ctx.store.register(ctx, 'driver_modbus', MODBUS_TABLES)

    const operator = (): string => settings.get<string | null>(SESSION_OPERATOR_KEY) ?? 'client'

    rpc.claimDomain(ctx, 'field.modbus')
    ctx.field.registerDriver(ctx, {
      id: 'modbus',
      title: 'Modbus TCP',
      mappings: () => projectMapping(readDocument(store)),
    })

    const auditAndNotify = (action: string, subject: string): void => {
      audit.record({ actor: operator(), action, subject })
      ctx.emit('modbus/config-changed')
      // Same notice for renderer watchers; the host event above only reaches
      // host-side listeners such as the driver itself. Bindings ride the
      // generic mappings frame the field seam broadcasts.
      rpc.broadcast('field/modbus-config-changed', {})
      field.mappingsChanged()
    }

    const notFound = (what: string): RpcBusinessError =>
      new RpcBusinessError({ code: 'not-found', details: { what } })

    const conflict = (what: string): RpcBusinessError =>
      new RpcBusinessError({ code: 'conflict', details: { what } })

    rpc.frame(ctx, 'field/modbus-config-changed', { payload: modbusConfigChangedSchema })

    rpc.method(ctx, 'field.modbus.devices.list', { request: modbusRequestSchemas['field.modbus.devices.list'] }, () =>
      readDocument(store))

    rpc.method(ctx, 'field.modbus.devices.upsert', { request: modbusRequestSchemas['field.modbus.devices.upsert'] }, ({ device }) => {
      store.tx(() => {
        store.run(
          `INSERT INTO ${store.table('devices')} (id, title, host, port, unit_id, poll_ms, timeout_ms, byte_order, enabled) `
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET title = excluded.title, host = excluded.host, port = excluded.port, '
          + 'unit_id = excluded.unit_id, poll_ms = excluded.poll_ms, timeout_ms = excluded.timeout_ms, '
          + 'byte_order = excluded.byte_order, enabled = excluded.enabled',
          [device.id, device.title, device.host, device.port, device.unitId, device.pollMs, device.timeoutMs,
            device.byteOrder, device.enabled ? 1 : 0],
        )
      })
      auditAndNotify('modbus.device.upsert', device.id)
      return { applied: true } as const
    })

    rpc.method(ctx, 'field.modbus.devices.remove', { request: modbusRequestSchemas['field.modbus.devices.remove'] }, ({ id }) => {
      const removed = store.tx(() => {
        const existing = store.get(`SELECT id FROM ${store.table('devices')} WHERE id = ?`, [id])
        if (existing === undefined) return false
        store.run(`DELETE FROM ${store.table('devices')} WHERE id = ?`, [id])
        store.run(`DELETE FROM ${store.table('groups')} WHERE device_id = ?`, [id])
        store.run(`DELETE FROM ${store.table('points')} WHERE device_id = ?`, [id])
        return true
      })
      if (!removed) throw notFound(`unknown device: ${id}`)
      auditAndNotify('modbus.device.remove', id)
      return { applied: true } as const
    })

    rpc.method(ctx, 'field.modbus.devices.test', { request: modbusRequestSchemas['field.modbus.devices.test'] }, ({ device }) =>
      probeDevice(device))

    rpc.method(ctx, 'field.modbus.groups.upsert', { request: modbusRequestSchemas['field.modbus.groups.upsert'] }, ({ group }) => {
      const device = store.get(`SELECT id FROM ${store.table('devices')} WHERE id = ?`, [group.deviceId])
      if (device === undefined) throw notFound(`unknown device: ${group.deviceId}`)
      const existing = store.get<{ type: string }>(
        `SELECT type FROM ${store.table('groups')} WHERE device_id = ? AND name = ?`,
        [group.deviceId, group.name])
      if (existing !== undefined && existing.type !== group.type) {
        // A live type change would strand the member points on the old type;
        // the settings page recreates groups instead of retyping them.
        const members = store.get(`SELECT var FROM ${store.table('points')} WHERE device_id = ? AND group_name = ?`,
          [group.deviceId, group.name])
        if (members !== undefined) throw conflict(`group ${group.deviceId}/${group.name} still holds points`)
      }
      store.run(
        `INSERT INTO ${store.table('groups')} (device_id, name, type) VALUES (?, ?, ?) `
        + 'ON CONFLICT(device_id, name) DO UPDATE SET type = excluded.type',
        [group.deviceId, group.name, group.type],
      )
      auditAndNotify('modbus.group.upsert', `${group.deviceId}/${group.name}`)
      return { applied: true } as const
    })

    rpc.method(ctx, 'field.modbus.groups.remove', { request: modbusRequestSchemas['field.modbus.groups.remove'] }, ({ deviceId, name }) => {
      const removed = store.tx(() => {
        const existing = store.get(`SELECT name FROM ${store.table('groups')} WHERE device_id = ? AND name = ?`,
          [deviceId, name])
        if (existing === undefined) return false
        store.run(`DELETE FROM ${store.table('groups')} WHERE device_id = ? AND name = ?`, [deviceId, name])
        // The group's points go with it, like a removed device's do.
        store.run(`DELETE FROM ${store.table('points')} WHERE device_id = ? AND group_name = ?`, [deviceId, name])
        return true
      })
      if (!removed) throw notFound(`unknown group: ${deviceId}/${name}`)
      auditAndNotify('modbus.group.remove', `${deviceId}/${name}`)
      return { applied: true } as const
    })

    rpc.method(ctx, 'field.modbus.points.upsert', { request: modbusRequestSchemas['field.modbus.points.upsert'] }, ({ point }) => {
      const device = store.get(`SELECT id FROM ${store.table('devices')} WHERE id = ?`, [point.deviceId])
      if (device === undefined) throw notFound(`unknown device: ${point.deviceId}`)
      // The group is a typed entity: membership both exists and fixes the
      // point's semantic type — this is the same-type-per-group rule.
      const group = store.get<{ type: string }>(
        `SELECT type FROM ${store.table('groups')} WHERE device_id = ? AND name = ?`,
        [point.deviceId, point.group])
      if (group === undefined) throw notFound(`unknown group: ${point.deviceId}/${point.group}`)
      if (group.type !== point.type) {
        throw conflict(`group ${point.deviceId}/${point.group} holds ${group.type} points, not ${point.type}`)
      }
      store.run(
        `INSERT INTO ${store.table('points')} (var, device_id, type, fc, address, encoding, scale, writable, deadband, group_name) `
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(device_id, group_name, var) DO UPDATE SET type = excluded.type, fc = excluded.fc, '
        + 'address = excluded.address, encoding = excluded.encoding, '
        + 'scale = excluded.scale, writable = excluded.writable, deadband = excluded.deadband',
        [point.var, point.deviceId, point.type, point.fc, point.address, point.encoding,
          point.scale ?? null, point.writable ? 1 : 0, point.deadband ?? null, point.group],
      )
      auditAndNotify('modbus.point.upsert', `${point.deviceId}/${point.group}/${point.var}`)
      return { applied: true } as const
    })

    rpc.method(ctx, 'field.modbus.points.remove', { request: modbusRequestSchemas['field.modbus.points.remove'] }, ({ deviceId, group, name }) => {
      const removed = store.tx(() => {
        const existing = store.get(
          `SELECT var FROM ${store.table('points')} WHERE device_id = ? AND group_name = ? AND var = ?`,
          [deviceId, group, name])
        if (existing === undefined) return false
        store.run(
          `DELETE FROM ${store.table('points')} WHERE device_id = ? AND group_name = ? AND var = ?`,
          [deviceId, group, name])
        return true
      })
      if (!removed) throw notFound(`unknown point: ${deviceId}/${group}/${name}`)
      auditAndNotify('modbus.point.remove', `${deviceId}/${group}/${name}`)
      return { applied: true } as const
    })
  },
}

export default modbusRpcPlugin
