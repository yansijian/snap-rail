/**
 * The production-stats store tables (namespace `production_stats`, database
 * `data/production_stats.db`). `last_sample` rides as TEXT so 64-bit device
 * counters round-trip without precision loss, tagged with the binding that
 * produced it — a baseline is only reusable while both match. Rows survive
 * plugin reload: data, not the registering fiber, is the artifact.
 *
 * @module @snap-rail/suite-terminal-ops/production/tables
 */

import type { StoreSchema } from '@snap-rail/store'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The shift counters behind the shift rows and the login anchor. */
export const shifts = sqliteTable('shifts', {
  shiftKey: text('shift_key').primaryKey(),
  count: integer('count').notNull().default(0),
  lastSample: text('last_sample'),
  binding: text('binding'),
  updatedAt: integer('updated_at').notNull(),
})

/** The rolling hourly chart buckets. */
export const hours = sqliteTable('hours', {
  hourStart: integer('hour_start').primaryKey(),
  count: integer('count').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

/** The single login anchor row (id is always 1; the app enforces it). */
export const anchor = sqliteTable('anchor', {
  id: integer('id').primaryKey(),
  operator: text('operator').notNull(),
  loginAt: integer('login_at').notNull(),
  shiftKey: text('shift_key').notNull(),
})

/** The namespace's drizzle schema. */
export const PRODUCTION_SCHEMA: StoreSchema = { shifts, hours, anchor }
