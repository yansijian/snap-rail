/**
 * The trend store tables (namespace `trend`, database `data/trend.db`).
 * Change points, not buckets: one row per observed value change, so the
 * record is lossless at the driver's own resolution (deadband points cost
 * near nothing) and any window can be reconstructed later. Binding hits ride
 * beside them as the per-profile event corpus the engine learns from.
 * Values ride tagged TEXT (`./values.ts`) so 64-bit counters round-trip.
 *
 * @module @snap-rail/trend/tables
 */

import type { StoreSchema } from '@snap-rail/store'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** One observed value change: (point, time) → tagged value. `null` is a
 * recorded value too (an abnormal stretch is signal, not absence). */
export const trendChanges = sqliteTable('changes', {
  pointKey: text('point_key').notNull(),
  time: integer('time').notNull(),
  value: text('value').notNull(),
}, table => [
  primaryKey({ columns: [table.pointKey, table.time] }),
])

/** One binding hit for a profile: the event moments the engine learns from. */
export const trendHits = sqliteTable('hits', {
  profileId: text('profile_id').notNull(),
  time: integer('time').notNull(),
  topic: text('topic').notNull(),
  /** JSON snapshot of the matching payload (evidence, not parsed back). */
  payload: text('payload').notNull(),
}, table => [
  primaryKey({ columns: [table.profileId, table.time, table.topic] }),
])

/** One observation profile; the shape rides the JSON `config` column so the
 * contract schema (not the store) owns its evolution. */
export const trendProfiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** The namespace's drizzle schema. */
export const TREND_SCHEMA = { changes: trendChanges, hits: trendHits, profiles: trendProfiles } satisfies StoreSchema
