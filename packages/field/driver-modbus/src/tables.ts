/**
 * The driver's store tables, shared by the driver (read + reconcile) and the
 * bridge (write + notify). Declared once so both entries converge on the
 * same physical `driver_modbus__*` tables.
 *
 * @module @snap-rail/driver-modbus/tables
 */

import type { StoreTableDef } from '@snap-rail/store'

/** Declarative table set for the `driver_modbus` store namespace. */
export const MODBUS_TABLES: readonly StoreTableDef[] = [
  {
    name: 'devices',
    create: 'id TEXT PRIMARY KEY, title TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, '
      + 'unit_id INTEGER NOT NULL, poll_ms INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, enabled INTEGER NOT NULL',
  },
  {
    name: 'points',
    create: 'var TEXT PRIMARY KEY, device_id TEXT NOT NULL, type TEXT NOT NULL, fc INTEGER NOT NULL, '
      + 'address INTEGER NOT NULL, encoding TEXT NOT NULL, byte_order TEXT NOT NULL, '
      + 'scale REAL, writable INTEGER NOT NULL, deadband REAL',
  },
  {
    name: 'vars',
    create: 'name TEXT PRIMARY KEY, type TEXT NOT NULL',
  },
]
