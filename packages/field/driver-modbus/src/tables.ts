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
      + 'unit_id INTEGER NOT NULL, poll_ms INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, '
      + "byte_order TEXT NOT NULL DEFAULT 'abcd', enabled INTEGER NOT NULL",
    // Word order moved from points to the device; legacy rows default on read.
    addColumns: ["byte_order TEXT NOT NULL DEFAULT 'abcd'"],
  },
  {
    name: 'groups',
    create: 'device_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (device_id, name)',
  },
  {
    // Identity is the triple (device, group, name); names are unique per
    // group only. Legacy dev databases carry a var-only primary key — the
    // composite conflict clause does not apply there, recreate the db.
    name: 'points',
    create: 'var TEXT NOT NULL, device_id TEXT NOT NULL, type TEXT NOT NULL, fc INTEGER NOT NULL, '
      + 'address INTEGER NOT NULL, encoding TEXT NOT NULL, '
      + 'scale REAL, writable INTEGER NOT NULL, deadband REAL, group_name TEXT NOT NULL, '
      + 'PRIMARY KEY (device_id, group_name, var)',
    // `group` is a reserved word in SQL, hence the group_name column name;
    // pre-group legacy rows lack it (and are dropped on read).
    addColumns: ['group_name TEXT'],
  },
]
