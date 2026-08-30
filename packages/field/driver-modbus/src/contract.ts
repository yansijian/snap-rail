/**
 * The ModbusTCP dialect's wire contract: device/group/mapping schemas and
 * the `field.modbus.*` method rows this driver registers. The driver is a
 * provider of the field domain (the industrial-communication seam) — its
 * configuration surface is the `field.modbus` sub-namespace, not a peer
 * domain. This module is the merge point: programs importing it (the
 * driver, its bridge, the settings page, tests) see the rows; everyone
 * else stays untyped.
 *
 * Dialect discipline: everything Modbus-specific (function code, address,
 * encoding, byte order) lives here and in the driver's own tables — never
 * in the field seam's definition layer.
 *
 * @module @snap-rail/driver-modbus/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'
import type { PointType } from '@snap-rail/field'

/** Device id: short ASCII token (it becomes a connection id and a table key). */
export const modbusDeviceId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'device id must be [A-Za-z0-9_-]{1,64}')

/** Read function codes: 1 coils, 2 discrete inputs, 3 holding, 4 input registers. */
export type ModbusFc = 1 | 2 | 3 | 4

/** Register/coil encodings v1 understands, mapped to their semantic type. */
export type ModbusEncoding = 'coil' | 'discrete' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32'

/** Word order for two-register values: `abcd` big-endian first, `cdab`
 * word-swapped. A device-wide link property, carried on the device row. */
export const ModbusByteOrderSchema = z.enum(['abcd', 'cdab'])

export type ModbusByteOrder = z.output<typeof ModbusByteOrderSchema>

/** One connection: host, port, unit id, polling cadence, and the link-wide
 * word order for two-register values (one PLC never mixes word orders). */
export const modbusDeviceSchema = z.object({
  id: modbusDeviceId,
  title: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(502),
  unitId: z.number().int().min(0).max(247).default(1),
  pollMs: z.number().int().min(50).max(600_000).default(1_000),
  timeoutMs: z.number().int().min(50).max(10_000).default(1_000),
  byteOrder: ModbusByteOrderSchema.default('abcd'),
  enabled: z.boolean().default(true),
}).strict()

export type ModbusDeviceConfig = z.output<typeof modbusDeviceSchema>

/**
 * One business group: an explicitly created section of a device holding
 * points of exactly one semantic type (the type lives here, so membership
 * enforces consistency structurally). Pages bind to a group as
 * `{ device, group }`.
 */
export const modbusGroupSchema = z.object({
  deviceId: modbusDeviceId,
  /** Group label within the device; the pair identifies the group. The name
   * rejects `/` so the field seam's composite key stays unambiguous. */
  name: z.string().trim().min(1).max(128).refine(
    value => !value.includes('/'), 'group name must not contain "/"'),
  /** The one semantic type every member point must carry. */
  type: z.enum(['bool', 'int', 'float']),
}).strict()

export type ModbusGroupConfig = z.output<typeof modbusGroupSchema>

/**
 * One variable mapping. Identity is the triple `(deviceId, group, var)` —
 * the name is unique within its group only, and consumers address the point
 * by that same triple on the field seam (see `PointRef`).
 */
export const modbusPointSchema = z.object({
  /** Point name within the group; also the business name pages display. */
  var: z.string().min(1).max(128).refine(
    value => !value.includes('/'), 'point name must not contain "/"'),
  deviceId: modbusDeviceId,
  /** The declared semantic type; validated against the encoding below and
   * against the group's type at the bridge. */
  type: z.enum(['bool', 'int', 'float']),
  fc: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Zero-based raw address (no 4xxxx convention). */
  address: z.number().int().min(0).max(65_535),
  encoding: z.enum(['coil', 'discrete', 'i16', 'u16', 'i32', 'u32', 'f32']),
  /** Multiply the raw value on decode (f32 only); defaults to 1. */
  scale: z.number().refine(value => value !== 0).optional(),
  writable: z.boolean().default(false),
  /** Deadband for float change detection; 0 (exact compare) by default. */
  deadband: z.number().min(0).optional(),
  /** The group this point belongs to (identity, not a presentation label). */
  group: z.string().trim().min(1).max(128).refine(
    value => !value.includes('/'), 'group name must not contain "/"'),
}).strict().superRefine((point, issues) => {
  const encodingType: Record<ModbusEncoding, PointType> = {
    coil: 'bool', discrete: 'bool',
    i16: 'int', u16: 'int', i32: 'int', u32: 'int',
    f32: 'float',
  }
  if (encodingType[point.encoding] !== point.type) {
    issues.addIssue({ code: 'custom', message: `encoding ${point.encoding} carries type ${encodingType[point.encoding]}, not ${point.type}`, path: ['encoding'] })
  }
  if (point.encoding === 'coil' && point.fc !== 1) {
    issues.addIssue({ code: 'custom', message: 'coil encoding reads with fc 1', path: ['fc'] })
  }
  if (point.encoding === 'discrete' && point.fc !== 2) {
    issues.addIssue({ code: 'custom', message: 'discrete encoding reads with fc 2', path: ['fc'] })
  }
  if (point.encoding !== 'coil' && point.encoding !== 'discrete' && point.fc !== 3 && point.fc !== 4) {
    issues.addIssue({ code: 'custom', message: 'register encodings read with fc 3 or 4', path: ['fc'] })
  }
  if (point.writable && point.fc !== 1 && point.fc !== 3) {
    issues.addIssue({ code: 'custom', message: 'input spaces (fc 2/4) are read-only', path: ['writable'] })
  }
  if (point.writable && point.encoding === 'discrete') {
    issues.addIssue({ code: 'custom', message: 'discrete inputs are read-only', path: ['writable'] })
  }
  if (point.scale !== undefined && point.encoding !== 'f32') {
    issues.addIssue({ code: 'custom', message: 'scale applies to f32 only', path: ['scale'] })
  }
  if (point.deadband !== undefined && point.encoding !== 'f32') {
    issues.addIssue({ code: 'custom', message: 'deadband applies to f32 only', path: ['deadband'] })
  }
})

export type ModbusPointConfig = z.output<typeof modbusPointSchema>

/** Everything the settings page renders, in one read. */
export interface ModbusDevicesDocument {
  devices: readonly ModbusDeviceConfig[]
  groups: readonly ModbusGroupConfig[]
  points: readonly ModbusPointConfig[]
}

/**
 * ModbusTCP device administration: CRUD over the driver's device, group,
 * and variable-mapping tables, plus a connection probe. Every mutation
 * writes the driver's store tables and hot-applies per device.
 */
export interface ModbusApi {
  /** The whole document the settings page renders: devices, groups, mappings. */
  listDevices(payload: {}): Promise<RpcResponse<ModbusDevicesDocument>>
  /** Insert or replace one device; reconnects only that device when live. */
  upsertDevice(payload: { device: ModbusDeviceConfig }): Promise<RpcResponse<{ applied: true }>>
  /** Remove one device, its groups, and its mappings; drops the connection. */
  removeDevice(payload: { id: string }): Promise<RpcResponse<{ applied: true }>>
  /** Probe a device address without touching the stored table. */
  testDevice(payload: { device: ModbusDeviceConfig }): Promise<RpcResponse<{ ok: boolean, error?: string | undefined }>>
  /** Insert or replace one group; a type change is refused while points hold the old type. */
  upsertGroup(payload: { group: ModbusGroupConfig }): Promise<RpcResponse<{ applied: true }>>
  /** Remove one group and its member points. */
  removeGroup(payload: { deviceId: string, name: string }): Promise<RpcResponse<{ applied: true }>>
  /** Insert or replace one mapping; the referenced group must exist and share the point's type. */
  upsertPoint(payload: { point: ModbusPointConfig }): Promise<RpcResponse<{ applied: true }>>
  /** Remove one mapping by its identity triple. */
  removePoint(payload: { deviceId: string, group: string, name: string }): Promise<RpcResponse<{ applied: true }>>
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'field.modbus.devices.list': ModbusApi['listDevices']
    'field.modbus.devices.upsert': ModbusApi['upsertDevice']
    'field.modbus.devices.remove': ModbusApi['removeDevice']
    'field.modbus.devices.test': ModbusApi['testDevice']
    'field.modbus.groups.upsert': ModbusApi['upsertGroup']
    'field.modbus.groups.remove': ModbusApi['removeGroup']
    'field.modbus.points.upsert': ModbusApi['upsertPoint']
    'field.modbus.points.remove': ModbusApi['removePoint']
  }

  interface FrameMap {
    /** The modbus dialect configuration changed; dialect consumers re-pull. */
    'field/modbus-config-changed': Record<string, never>
  }
}

const emptyRequest = z.object({}).strict()

/** Request schemas for the `field.modbus.*` methods (ride with registration). */
export const modbusRequestSchemas = {
  'field.modbus.devices.list': emptyRequest,
  'field.modbus.devices.upsert': z.object({ device: modbusDeviceSchema }).strict(),
  'field.modbus.devices.remove': z.object({ id: z.string().min(1) }).strict(),
  'field.modbus.devices.test': z.object({ device: modbusDeviceSchema }).strict(),
  'field.modbus.groups.upsert': z.object({ group: modbusGroupSchema }).strict(),
  'field.modbus.groups.remove': z.object({ deviceId: z.string().min(1), name: z.string().min(1) }).strict(),
  'field.modbus.points.upsert': z.object({ point: modbusPointSchema }).strict(),
  'field.modbus.points.remove': z.object({
    deviceId: z.string().min(1),
    group: z.string().min(1),
    name: z.string().min(1),
  }).strict(),
} as const

/** Payload schema of the `field/modbus-config-changed` frame. */
export const modbusConfigChangedSchema = z.object({}).strict()
