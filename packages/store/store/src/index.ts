/**
 * The persistence seam — the specification half. `ctx.store.register(caller,
 * namespace, schema)` hands back a type-safe database for that namespace;
 * table creation and append-only column additions are derived from the
 * schema itself at registration. Tables survive plugin unload — data, not
 * the registering fiber, is the artifact.
 *
 * The drizzle query builder IS the specification: consumers declare their
 * tables as drizzle schema objects and use the query builder only — no raw
 * `sql` fragments beyond `excluded.*` upsert references, no vendor
 * functions, no CTEs, no window functions. The implementation package
 * (`@snap-rail/store-sqlite`) may then be swapped for another drizzle-backed
 * engine while consumer statements migrate mechanically.
 *
 * Physical isolation is the trust boundary of the plugin era: a namespace
 * is an isolation boundary (a file per namespace in the sqlite backend) —
 * one plugin's data is unreachable from every other namespace, and
 * uninstalling a plugin is deleting its namespace. Cross-namespace
 * collaboration goes through services, never shared tables.
 *
 * @module @snap-rail/store
 */

import type { Context } from '@snap-rail/cordis'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

/** A consumer's drizzle schema: physical table name → drizzle sqlite table. */
export type StoreSchema = Record<string, SQLiteTable>

/** The run-result shape drizzle's sync dialect reads back. */
export interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

/** The typed database a registered namespace hands back. */
export type StoreDatabase<S extends StoreSchema> = BaseSQLiteDatabase<'sync', RunResult, S>

/** The persistence service exposed on `ctx.store` (implemented by store-sqlite). */
export interface StoreService {
  /**
   * Open the namespace's database (created on first use) and bring its
   * tables to the declared shape: missing tables are created, columns added
   * since the last registration are appended (append-only by design — the
   * seam never drops or rewrites columns, and appended columns arrive
   * without constraints so old rows stay readable). Idempotent — repeat
   * registrations converge on the same physical tables.
   *
   * @param caller - owning context (registration is scoped to the call site).
   * @param namespace - stable short name, sanitized to `[a-z0-9]_`; it is
   * the isolation boundary (the database file name in the sqlite backend).
   * @param schema - the drizzle tables this namespace owns.
   */
  register<S extends StoreSchema>(caller: Context, namespace: string, schema: S): StoreDatabase<S>
}

declare module '@snap-rail/cordis' {
  interface Context {
    store: StoreService
  }
}
