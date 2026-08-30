/**
 * The driver's document readers: the whole ModbusTCP configuration as one
 * read over the store tables, plus the dialect-free projection into the
 * field seam's generic mapping view. Pure functions over a store handle —
 * no I/O, no driver runtime — so the bridge, the driver, and tests share
 * one reading of the tables.
 *
 * @module @snap-rail/driver-modbus/document
 */

import type { MappingDocument } from '@snap-rail/field'
import type { StoreHandle } from '@snap-rail/store'
import type { ModbusDeviceConfig, ModbusDevicesDocument, ModbusGroupConfig, ModbusPointConfig } from './contract.ts'

type DeviceRow = Record<string, unknown>

/** Collision-free identity of a group (ids are ASCII, names are free-form). */
function groupKey(deviceId: string, name: string): string {
  return JSON.stringify([deviceId, name])
}

/** Read the whole document (devices ascending, groups and points by name). */
export function readDocument(store: StoreHandle): ModbusDevicesDocument {
  const devices = store.all<Record<string, unknown>>(`SELECT * FROM ${store.table('devices')} ORDER BY id`)
    .map(rowFromDevice)
  const groups = store.all<Record<string, unknown>>(
    `SELECT * FROM ${store.table('groups')} ORDER BY device_id, name`)
    .map(rowFromGroup)
  const knownGroups = new Set(groups.map(group => groupKey(group.deviceId, group.name)))
  // Points must sit in an existing group; legacy rows without one (or whose
  // group entity is gone) have no place in the document the settings page
  // and the binding resolver share.
  const points = store.all<Record<string, unknown>>(`SELECT * FROM ${store.table('points')} ORDER BY var`)
    .filter(row => row.group_name !== null && row.group_name !== undefined)
    .map(rowFromPoint)
    .filter(point => knownGroups.has(groupKey(point.deviceId, point.group)))
  return { devices, groups, points }
}

function rowFromDevice(row: DeviceRow): ModbusDeviceConfig {
  return {
    id: String(row.id),
    title: String(row.title),
    host: String(row.host),
    port: Number(row.port),
    unitId: Number(row.unit_id),
    pollMs: Number(row.poll_ms),
    timeoutMs: Number(row.timeout_ms),
    byteOrder: row.byte_order === 'cdab' ? 'cdab' : 'abcd',
    enabled: Number(row.enabled) === 1,
  }
}

function rowFromGroup(row: DeviceRow): ModbusGroupConfig {
  return {
    deviceId: String(row.device_id),
    name: String(row.name),
    type: row.type as ModbusGroupConfig['type'],
  }
}

function rowFromPoint(row: DeviceRow): ModbusPointConfig {
  return {
    var: String(row.var),
    deviceId: String(row.device_id),
    type: row.type as ModbusPointConfig['type'],
    fc: Number(row.fc) as ModbusPointConfig['fc'],
    address: Number(row.address),
    encoding: row.encoding as ModbusPointConfig['encoding'],
    scale: row.scale === null ? undefined : Number(row.scale),
    writable: Number(row.writable) === 1,
    deadband: row.deadband === null ? undefined : Number(row.deadband),
    group: String(row.group_name),
  }
}

/**
 * Project the dialect document into the field seam's generic mapping view.
 * Points come out sorted by function code, address, then name — the
 * projection-defined order bindings preserve (the first active member is a
 * stable "primary").
 */
export function projectMapping(doc: ModbusDevicesDocument): MappingDocument {
  const sorted = [...doc.points].sort((a, b) =>
    a.fc - b.fc || a.address - b.address || a.var.localeCompare(b.var))
  return {
    devices: doc.devices.map(device => ({ id: device.id, driver: 'modbus' })),
    groups: doc.groups.map(group => ({ deviceId: group.deviceId, name: group.name, type: group.type })),
    points: sorted.map(point => ({ deviceId: point.deviceId, group: point.group, name: point.var })),
  }
}
