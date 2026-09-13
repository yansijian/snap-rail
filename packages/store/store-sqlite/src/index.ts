/**
 * The persistence seam's reference implementation: one SQLite database per
 * namespace under the snap-rail home (`data/<namespace>.db`), owned by
 * `ctx.store`, over node:sqlite (no native rebuilds) through drizzle's
 * better-sqlite3 session duck-typed onto node:sqlite's synchronous API.
 * Single-active with any other store backend (`snapRail.exclusive`).
 *
 * @module @snap-rail/store-sqlite
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { StoreDatabase, StoreSchema, StoreService } from '@snap-rail/store'
import '@snap-rail/store'
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session'
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations'
import {
  BaseSQLiteDatabase,
  SQLiteSyncDialect,
  getTableConfig,
  type SQLiteColumn,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core'

/** The run-result shape drizzle's sync sqlite dialect reads back. */
interface RunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

/** A better-sqlite3-shaped statement facade over node:sqlite's sync API. */
interface AdaptedStatement {
  run(...params: unknown[]): RunResult
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  raw(): { all(...params: unknown[]): unknown[][], get(...params: unknown[]): unknown[] | undefined }
}

/** node:sqlite's positional binding parameters. */
type SyncParams = Parameters<StatementSync['run']>

/**
 * drizzle's better-sqlite3 dialect duck-types onto node:sqlite's synchronous
 * statements. The one genuine gap is raw mode (positional rows): node:sqlite
 * only emits object rows, but its binding writes object keys in result-column
 * order, so `Object.values` recovers the positional form.
 */
function adaptStatement(stmt: StatementSync): AdaptedStatement {
  return {
    run: (...params) => stmt.run(...(params as SyncParams)) as RunResult,
    all: (...params) => stmt.all(...(params as SyncParams)) as Record<string, unknown>[],
    get: (...params) => stmt.get(...(params as SyncParams)) as Record<string, unknown> | undefined,
    raw: () => ({
      all: (...params) => (stmt.all(...(params as SyncParams)) as object[]).map(row => Object.values(row)),
      get: (...params) => {
        const row = stmt.get(...(params as SyncParams)) as object | undefined
        return row === undefined ? undefined : Object.values(row)
      },
    }),
  }
}

/** A better-sqlite3-shaped client facade: prepare + transaction thunks. */
function adaptClient(db: DatabaseSync): { prepare: (sql: string) => AdaptedStatement, transaction(fn: (argument?: unknown) => unknown): { deferred(argument?: unknown): unknown, immediate(argument?: unknown): unknown, exclusive(argument?: unknown): unknown } } {
  return {
    prepare: sql => adaptStatement(db.prepare(sql)),
    transaction: (fn: (argument?: unknown) => unknown) => {
      // better-sqlite3 semantics: each thunk opens the transaction and hands
      // its argument (drizzle's tx object) to the body.
      const run = (mode: string) => (argument?: unknown): unknown => {
        db.exec(mode === '' ? 'BEGIN' : `BEGIN ${mode}`)
        try {
          const result = fn(argument)
          db.exec('COMMIT')
          return result
        } catch (cause) {
          db.exec('ROLLBACK')
          throw cause
        }
      }
      return { deferred: run(''), immediate: run('IMMEDIATE'), exclusive: run('EXCLUSIVE') }
    },
  }
}

/**
 * Assemble drizzle's sync sqlite database over node:sqlite. The package's
 * `drizzle-orm/better-sqlite3` entry cannot be used: its top level imports
 * the native `better-sqlite3` module, which this backend deliberately does not
 * ship (node:sqlite keeps the host free of native rebuilds).
 */
function drizzleOverNodeSqlite<S extends StoreSchema>(client: DatabaseSync, schema: S): StoreDatabase<S> {
  const dialect = new SQLiteSyncDialect()
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
  const relational = {
    fullSchema: schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  }
  const session = new BetterSQLiteSession(adaptClient(client), dialect, relational)
  // The generic plumbing (session ↔ schema variance) is wider than the public
  // type needs; the runtime binding is exactly S.
  const db = new BaseSQLiteDatabase('sync', dialect, session as never, relational as never)
  return db as unknown as StoreDatabase<S>
}

/** Lowercase and flatten anything non-alphanumeric so names are file-safe. */
function sanitize(raw: string): string {
  return raw.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')
}

/** The SQL type of a drizzle column (`text`, `integer`, `real`, …). */
function sqlType(column: SQLiteColumn): string {
  return (column as unknown as { getSQLType(): string }).getSQLType().toUpperCase()
}

/**
 * `CREATE TABLE IF NOT EXISTS` synthesized from the drizzle table object —
 * column NOT NULL flags ride along, a single primary key lands on its column,
 * composite keys become a table-level clause. Column DEFAULTs are omitted:
 * drizzle applies JS-side defaults at query-build time, and appended columns
 * must arrive constraint-free anyway.
 */
function createTableSql(table: SQLiteTable): string {
  const config = getTableConfig(table)
  const primary = new Set<string>()
  for (const key of config.primaryKeys) {
    for (const column of key.columns) primary.add(column.name)
  }
  for (const column of config.columns) {
    if (column.primary) primary.add(column.name)
  }
  const defs: string[] = []
  for (const column of config.columns) {
    const parts = [`"${column.name}"`, sqlType(column)]
    if (column.notNull) parts.push('NOT NULL')
    if (primary.size === 1 && primary.has(column.name)) parts.push('PRIMARY KEY')
    defs.push(parts.join(' '))
  }
  if (primary.size > 1) {
    const names = config.columns.filter(c => primary.has(c.name)).map(c => `"${c.name}"`)
    defs.push(`PRIMARY KEY (${names.join(', ')})`)
  }
  return `CREATE TABLE IF NOT EXISTS "${config.name}" (${defs.join(', ')})`
}

/** Bring the namespace's physical tables to the declared shape (idempotent). */
function bringToShape(client: DatabaseSync, schema: StoreSchema): void {
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table)
    client.exec(createTableSql(table))
    const existing = new Set(
      (client.prepare(`PRAGMA table_info("${config.name}")`).all() as Array<{ name: string }>)
        .map(info => info.name),
    )
    for (const column of config.columns) {
      if (existing.has(column.name)) continue
      client.exec(`ALTER TABLE "${config.name}" ADD COLUMN "${column.name}" ${sqlType(column)}`)
    }
  }
}

/**
 * Mounts `ctx.store` over node:sqlite. All state rides construction-time
 * closures: traceable context proxies rebind `this` on every method access,
 * so `this`-reached state cannot back a service here (the uiSlots lesson).
 */
const storeSqlitePlugin: Plugin.Function = Object.assign(
  function storeSqlite(ctx: Context): void {
    const home = ctx.get('snapRailHome') as string | undefined
    if (home === undefined) throw new Error('store-sqlite: snapRailHome is not provided')
    mkdirSync(join(home, 'data'), { recursive: true })

    // One database file per namespace; registration converges on the same
    // physical client, so multiple entries of one package share the handle.
    const clients = new Map<string, DatabaseSync>()
    const clientFor = (namespace: string): DatabaseSync => {
      let client = clients.get(namespace)
      if (client === undefined) {
        client = new DatabaseSync(join(home, 'data', `${namespace}.db`))
        client.exec('PRAGMA journal_mode = WAL')
        clients.set(namespace, client)
      }
      return client
    }

    const service: StoreService = {
      register<S extends StoreSchema>(_caller: Context, namespace: string, schema: S): StoreDatabase<S> {
        const client = clientFor(sanitize(namespace))
        bringToShape(client, schema)
        return drizzleOverNodeSqlite(client, schema)
      },
    }
    ctx.provide('store', service)

    // Release file handles when the host tree unloads; on Windows an open
    // handle would block removing the home directory.
    ctx.effect(() => () => {
      for (const client of clients.values()) client.close()
      clients.clear()
    })
  },
  { inject: ['snapRailHome'] },
)

export default storeSqlitePlugin
