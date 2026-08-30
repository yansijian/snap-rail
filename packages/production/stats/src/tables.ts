/**
 * The production-stats store tables (namespace `production_stats`).
 * `last_sample` rides as TEXT so 64-bit device counters round-trip without
 * precision loss, tagged with the binding that produced it — a baseline is
 * only reusable while both match. Rows survive plugin reload: data, not the
 * registering fiber, is the artifact.
 *
 * @module @snap-rail/production-stats/tables
 */

import type { StoreTableDef } from '@snap-rail/store'

/** Tables behind the shift counters, the hour chart, and the login anchor. */
export const PRODUCTION_TABLES: readonly StoreTableDef[] = [
  {
    name: 'shifts',
    create: 'shift_key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, '
      + 'last_sample TEXT, binding TEXT, updated_at INTEGER NOT NULL',
  },
  {
    name: 'hours',
    create: 'hour_start INTEGER PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL',
  },
  {
    name: 'anchor',
    create: 'id INTEGER PRIMARY KEY CHECK (id = 1), operator TEXT NOT NULL, login_at INTEGER NOT NULL, shift_key TEXT NOT NULL',
  },
]
