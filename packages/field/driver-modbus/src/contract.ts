/**
 * The ModbusTCP dialect: the schemas a driver registers with the field base.
 * Device identity (id/name) and group membership belong to the base's
 * configuration tables; everything here is the pure dialect — link
 * parameters on the device config, addressing/encoding on the point config.
 * The point schema validates the merged `{ type, ...config }` object (the
 * base supplies the type from the group; the stored config is the dialect
 * part alone).
 *
 * @module @snap-rail/driver-modbus/contract
 */

import { z } from 'zod'
import type { PointType } from '@snap-rail/field'

/** Read function codes: 1 coils, 2 discrete inputs, 3 holding, 4 input registers. */
export type ModbusFc = 1 | 2 | 3 | 4

/** Register/coil encodings v1 understands, mapped to their semantic type. */
export type ModbusEncoding = 'coil' | 'discrete' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32'

/** Word order for two-register values: `abcd` big-endian first, `cdab`
 * word-swapped. A device-wide link property. */
export const ModbusByteOrderSchema = z.enum(['abcd', 'cdab'])

export type ModbusByteOrder = z.output<typeof ModbusByteOrderSchema>

/** The dialect part of a device config: link parameters and poll cadence.
 * `.meta({ title })` labels the settings form (zod → JSON Schema → SchemaForm). */
export const modbusDeviceSchema = z.object({
  host: z.string().min(1).max(253).meta({ title: '主机地址' }),
  port: z.number().int().min(1).max(65535).default(502).meta({ title: '端口' }),
  unitId: z.number().int().min(0).max(247).default(1).meta({ title: '单元号' }),
  pollMs: z.number().int().min(50).max(600_000).default(1_000).meta({ title: '轮询周期 (ms)' }),
  timeoutMs: z.number().int().min(50).max(10_000).default(1_000).meta({ title: '超时 (ms)' }),
  byteOrder: ModbusByteOrderSchema.default('abcd').meta({ title: '字序' }),
  /** Disabled devices keep their configuration but never poll. */
  enabled: z.boolean().default(true).meta({ title: '启用' }),
}).strict()

export type ModbusDeviceConfig = z.output<typeof modbusDeviceSchema>

/** The encoding → semantic type map the point refinement enforces. */
const encodingType: Record<ModbusEncoding, PointType> = {
  coil: 'bool', discrete: 'bool',
  i16: 'int', u16: 'int', i32: 'int', u32: 'int',
  f32: 'float',
}

/** The dialect part of a point config: addressing, encoding, write policy.
 * `type` arrives from the group (the base supplies it; the unified settings
 * form hides the field); the refinement pins encoding against it. Unknown
 * keys strip (not reject) so dialect fields retired from the schema never
 * brick rows already stored. */
export const modbusPointSchema = z.object({
  type: z.enum(['bool', 'int', 'float']).meta({ title: '类型' }),
  fc: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).meta({ title: '功能码' }),
  /** Zero-based raw address (no 4xxxx convention). */
  address: z.number().int().min(0).max(65_535).meta({ title: '地址' }),
  encoding: z.enum(['coil', 'discrete', 'i16', 'u16', 'i32', 'u32', 'f32']).meta({ title: '编码' }),
  writable: z.boolean().default(false).meta({ title: '可写' }),
  /** Deadband for numeric change detection; 0 (exact compare) by default. */
  deadband: z.number().min(0).optional().meta({ title: '变化死区' }),
}).superRefine((point, issues) => {
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
  if (point.deadband !== undefined && (point.encoding === 'coil' || point.encoding === 'discrete')) {
    issues.addIssue({ code: 'custom', message: 'deadband applies to numeric encodings only', path: ['deadband'] })
  }
})

export type ModbusPointConfig = z.output<typeof modbusPointSchema>

/** The stored dialect config of one point (the `type` context stripped). */
export type ModbusPointDialect = Omit<ModbusPointConfig, 'type'>
