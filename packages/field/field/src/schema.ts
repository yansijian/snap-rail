/**
 * The field base's own tables (namespace `field`, database
 * `data/field.db`): the device/group/point configuration every driver's
 * connections are built from. Dialect fields (function codes, addresses,
 * encodings) live inside the JSON `config` columns, validated by the owning
 * driver's schemas — never as columns of their own.
 *
 * A point's semantic type is its group's type (same group, same type); the
 * points table deliberately carries no type column. Deleting a group
 * cascades to its points; deleting a device cascades to everything under it.
 *
 * @module @snap-rail/field/schema
 */

import type { StoreSchema } from '@snap-rail/store'
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** One configured device: base identity plus the driver's dialect config. */
export const fieldDevices = sqliteTable('devices', {
  /** Stable address identity (minted from the name); part of every point triple. */
  id: text('id').primaryKey(),
  /** Human-facing label (tab title, connection title). */
  name: text('name').notNull(),
  /** Owning driver id (`field.drivers.list`). */
  driverId: text('driver_id').notNull(),
  /** JSON of the driver-validated dialect config. */
  config: text('config').notNull(),
})

/** One typed group: point identity lives under (device, group). */
export const fieldGroups = sqliteTable('groups', {
  deviceId: text('device_id').notNull(),
  name: text('name').notNull(),
  /** The group's semantic point type (`PointType`); members must match. */
  type: text('type').notNull(),
}, table => [
  primaryKey({ columns: [table.deviceId, table.name] }),
])

/** One configured point: the triple plus its dialect config. */
export const fieldPoints = sqliteTable('points', {
  deviceId: text('device_id').notNull(),
  group: text('group').notNull(),
  name: text('name').notNull(),
  /** JSON of the driver-validated dialect config. */
  config: text('config').notNull(),
}, table => [
  primaryKey({ columns: [table.deviceId, table.group, table.name] }),
])

/** The namespace's drizzle schema. */
export const FIELD_SCHEMA = { devices: fieldDevices, groups: fieldGroups, points: fieldPoints } satisfies StoreSchema
