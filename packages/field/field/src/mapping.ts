/**
 * The generic mapping view: how demand-side bindings see point-table
 * configuration across every driver, without any protocol dialect. A driver
 * that keeps mapping tables (ModbusTCP's devices/groups/points) projects
 * them into this shape when it registers with the field seam; the seam
 * aggregates all drivers into one document served by `field.mappings.list`.
 * Dialect fields (function codes, addresses, encodings) never appear here —
 * a binding resolves through the shared (device, group, name) triple only.
 *
 * Member order within a group is the projection's choice and is preserved
 * verbatim (drivers sort by their own dialect keys so the first active
 * member is a stable "primary").
 *
 * @module @snap-rail/field/mapping
 */

import type { PointType } from './model.ts'

/** One device in the mapping view; `driver` names the providing driver. */
export interface MappingDevice {
  id: string
  driver: string
}

/** One business group a binding can address as `{device, group}`. */
export interface MappingGroup {
  deviceId: string
  name: string
  /** The group's semantic type when the driver's tables are typed. */
  type?: PointType
}

/** One mapped point: the triple is the whole identity. */
export interface MappingPoint {
  deviceId: string
  group: string
  name: string
}

/** The aggregated mapping document served by `field.mappings.list`. */
export interface MappingDocument {
  devices: readonly MappingDevice[]
  groups: readonly MappingGroup[]
  points: readonly MappingPoint[]
}
