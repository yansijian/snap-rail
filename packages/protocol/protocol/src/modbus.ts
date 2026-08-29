/**
 * ModbusTCP wire types and boundary schemas: the device table and the
 * variable-to-register mapping as they cross the `modbus.*` methods. The
 * schemas are the single validation point (trust boundary); the driver and
 * its settings page share the inferred types.
 *
 * Dialect discipline: everything Modbus-specific (function code, address,
 * encoding, byte order) lives here and in the driver's own tables — never in
 * the field seam's definition layer.
 *
 * @module @snap-rail/protocol/modbus
 */

import { z } from 'zod'
import type { PointType } from './field.ts'

/** Device id: short ASCII token (it becomes a connection id and a table key). */
export const modbusDeviceId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'device id must be [A-Za-z0-9_-]{1,64}')

/** Read function codes: 1 coils, 2 discrete inputs, 3 holding, 4 input registers. */
export type ModbusFc = 1 | 2 | 3 | 4

/** Register/coil encodings v1 understands, mapped to their semantic type. */
export type ModbusEncoding = 'coil' | 'discrete' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32'

/** Word order for two-register values: `abcd` big-endian first, `cdab` word-swapped. */
export type ModbusByteOrder = 'abcd' | 'cdab'

/** One connection: host, port, unit id, and polling cadence. */
export const modbusDeviceSchema = z.object({
  id: modbusDeviceId,
  title: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(502),
  unitId: z.number().int().min(0).max(247).default(1),
  pollMs: z.number().int().min(50).max(600_000).default(1_000),
  timeoutMs: z.number().int().min(50).max(10_000).default(1_000),
  enabled: z.boolean().default(true),
}).strict()

export type ModbusDeviceConfig = z.output<typeof modbusDeviceSchema>

/** One variable mapping: name (= field point id), target device, and register layout. */
export const modbusPointSchema = z.object({
  var: z.string().min(1).max(128),
  deviceId: modbusDeviceId,
  /** The declared semantic type; validated against the encoding below. */
  type: z.enum(['bool', 'int', 'float']),
  fc: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Zero-based raw address (no 4xxxx convention). */
  address: z.number().int().min(0).max(65_535),
  encoding: z.enum(['coil', 'discrete', 'i16', 'u16', 'i32', 'u32', 'f32']),
  byteOrder: z.enum(['abcd', 'cdab']).default('abcd'),
  /** Multiply the raw value on decode (f32 only); defaults to 1. */
  scale: z.number().refine(value => value !== 0).optional(),
  writable: z.boolean().default(false),
  /** Deadband for float change detection; 0 (exact compare) by default. */
  deadband: z.number().min(0).optional(),
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
  const multiRegister = point.encoding === 'i32' || point.encoding === 'u32' || point.encoding === 'f32'
  if (!multiRegister && point.byteOrder !== 'abcd') {
    issues.addIssue({ code: 'custom', message: 'byteOrder applies to two-register encodings only', path: ['byteOrder'] })
  }
})

export type ModbusPointConfig = z.output<typeof modbusPointSchema>

/** A hand-declared debugging variable (the empty-registry acceptance path). */
export const modbusVarSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.enum(['bool', 'int', 'float']),
}).strict()

export type ModbusVarConfig = z.output<typeof modbusVarSchema>

/** Everything the settings page renders, in one read. */
export interface ModbusDevicesDocument {
  devices: readonly ModbusDeviceConfig[]
  points: readonly ModbusPointConfig[]
  vars: readonly ModbusVarConfig[]
}
