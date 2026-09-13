/**
 * The EtherNet/IP dialect: the schemas a driver registers with the equipment
 * base. Device identity (id/name) and group membership belong to the base's
 * configuration tables; everything here is the pure dialect — link
 * parameters on the device config, variable addressing on the point config.
 * The point schema validates the merged `{ type, ...config }` object (the
 * base supplies the type from the group; the stored config is the dialect
 * part alone).
 *
 * @module @snap-rail/driver-enip/contract
 */

import { z } from 'zod'

/** The dialect part of a device config: link parameters and poll cadence.
 * `.meta({ title })` labels the settings form (zod → JSON Schema → SchemaForm). */
export const enipDeviceSchema = z.object({
  host: z.string().min(1).max(253).meta({ title: '主机地址' }),
  port: z.number().int().min(1).max(65_535).default(44_848).meta({ title: '端口' }),
  /** Backplane slot for routed targets; 0 addresses the message port itself
   * (the Omron NX/NX1P2 built-in-port case). */
  slot: z.number().int().min(0).max(15).default(0).meta({ title: '槽号' }),
  pollMs: z.number().int().min(50).max(600_000).default(1_000).meta({ title: '轮询周期 (ms)' }),
  timeoutMs: z.number().int().min(50).max(10_000).default(1_000).meta({ title: '超时 (ms)' }),
  /** Disabled devices keep their configuration but never poll. */
  enabled: z.boolean().default(true).meta({ title: '启用' }),
}).strict()

export type EnipDeviceConfig = z.output<typeof enipDeviceSchema>

/** Sysmac global-variable names: a letter or underscore, then letters,
 * digits, or underscores (published variables carry no other spelling). */
const tagNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/

/** The dialect part of a point config: variable addressing and write policy.
 * `type` arrives from the group (the base supplies it; the unified settings
 * form hides the equipment); a variable whose CIP type maps elsewhere
 * surfaces at runtime as one `null` sample — the wire carries the type only
 * in the reply, so no static cross-check exists (the modbus encoding↔type
 * refinement has no analog here). Unknown keys strip (not reject) so
 * dialect fields retired from the schema never brick stored rows. */
export const enipPointSchema = z.object({
  type: z.enum(['bool', 'int', 'float']).meta({ title: '类型' }),
  /** Published global-variable name on the controller. */
  tag: z.string().regex(tagNamePattern, 'tag must be a controller variable name').meta({ title: '变量名', description: '已发布的全局变量名' }),
  writable: z.boolean().default(false).meta({ title: '可写' }),
  /** Deadband for numeric change detection; 0 (exact compare) by default. */
  deadband: z.number().min(0).optional().meta({ title: '变化死区' }),
}).superRefine((point, issues) => {
  if (point.deadband !== undefined && point.type === 'bool') {
    issues.addIssue({ code: 'custom', message: 'deadband applies to numeric types only', path: ['deadband'] })
  }
})

export type EnipPointConfig = z.output<typeof enipPointSchema>

/** The stored dialect config of one point (the `type` context stripped). */
export type EnipPointDialect = Omit<EnipPointConfig, 'type'>
