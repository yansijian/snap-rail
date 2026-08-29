/**
 * The persistence seam: one SQLite database under the snap-rail home
 * (`snap-rail.db`), owned by `ctx.store`. Consumers declare their tables on
 * registration (create-if-missing plus append-only column additions) and get
 * a thin SQL handle bound to their prefixed namespace. Tables survive plugin
 * unload — data, not the registering fiber, is the artifact.
 *
 * Portability contract: consumers issue plain, dialect-free CRUD SQL —
 * primary-key selects, whole-table lists, inserts, updates, deletes. No
 * vendor functions (date/time/json), no CTEs, no window functions; anything
 * richer belongs in application code. Switching the engine then means
 * re-implementing this one package while consumer statements migrate
 * mechanically.
 *
 * @module @snap-rail/store
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Context, type Plugin } from '@snap-rail/cordis'

/** One consumer table: its local name and creation/migration DDL. */
export interface StoreTableDef {
  /** Local table name; the physical name is `<prefix>__<name>`. */
  name: string
  /**
   * The full column definition list, as it goes between the parentheses of
   * `CREATE TABLE (...)` — constraints included.
   */
  create: string
  /**
   * Columns added after the table first shipped; each is applied as
   * `ALTER TABLE ... ADD COLUMN` when missing. Append-only by design: the
   * seam never drops or rewrites existing columns.
   */
  addColumns?: readonly string[]
}

/** A consumer's SQL handle: every statement is namespaced by construction. */
export interface StoreHandle {
  /** The physical (prefixed) table name for use in SQL text. */
  table(name: string): string
  /** Execute a write statement; parameters bind positionally. */
  run(sql: string, params?: readonly unknown[]): void
  /** Read at most one row, or `undefined`. */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  /** Read every matching row. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  /** Run `fn` inside one transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T
}

/** The persistence service exposed on `ctx.store`. */
export interface StoreService {
  /**
   * Register a consumer namespace: creates missing tables, applies pending
   * column additions, and returns the SQL handle. Idempotent — repeat
   * registrations converge on the same physical tables.
   *
   * @param caller - owning context (registration is scoped to the call site).
   * @param prefix - the consumer's stable short name (sanitized to
   * `[a-z0-9_]`); two prefixes sharing a table name share one physical table.
   * @param tables - the table declarations.
   */
  register(caller: Context, prefix: string, tables: readonly StoreTableDef[]): StoreHandle
}

declare module '@snap-rail/cordis' {
  interface Context {
    store: StoreService
  }
}

/** Lowercase and flatten anything non-alphanumeric so names are SQL-safe. */
function sanitize(raw: string): string {
  return raw.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')
}

/** First token of a column definition — its name (`"note TEXT"` → `note`). */
function columnName(columnDef: string): string {
  return columnDef.trim().split(/[\s(]+/)[0] as string
}

/**
 * Mounts `ctx.store`. All state rides construction-time closures: traceable
 * context proxies rebind `this` on every method access, so `this`-reached
 * state cannot back a service here (the uiSlots lesson).
 */
const storePlugin: Plugin.Function = Object.assign(
  function store(ctx: Context): void {
    const home = ctx.get('snapRailHome') as string | undefined
    if (home === undefined) throw new Error('store: snapRailHome is not provided')
    const file = join(home, 'snap-rail.db')
    mkdirSync(home, { recursive: true })

    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')

    const statements = new Map<string, StatementSync>()
    const prepare = (sql: string): StatementSync => {
      let stmt = statements.get(sql)
      if (stmt === undefined) {
        stmt = db.prepare(sql)
        statements.set(sql, stmt)
      }
      return stmt
    }

    let inTransaction = false

    const makeHandle = (prefix: string, tables: readonly StoreTableDef[]): StoreHandle => {
      const physical = (local: string): string => `${sanitize(prefix)}__${sanitize(local)}`
      for (const def of tables) {
        const table = physical(def.name)
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${def.create})`)
        for (const column of def.addColumns ?? []) {
          const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
          if (existing.some(info => info.name === columnName(column))) continue
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
        }
      }
      return {
        table: physical,
        run: (sql, params) => { prepare(sql).run(...((params ?? []) as Parameters<StatementSync['run']>)) },
        get: <T,>(sql: string, params?: readonly unknown[]): T | undefined =>
          prepare(sql).get(...((params ?? []) as Parameters<StatementSync['run']>)) as T | undefined,
        all: <T,>(sql: string, params?: readonly unknown[]): T[] =>
          prepare(sql).all(...((params ?? []) as Parameters<StatementSync['run']>)) as T[],
        tx: <T,>(fn: () => T): T => {
          if (inTransaction) return fn()
          inTransaction = true
          try {
            db.exec('BEGIN IMMEDIATE')
            const result = fn()
            db.exec('COMMIT')
            return result
          } catch (cause) {
            db.exec('ROLLBACK')
            throw cause
          } finally {
            inTransaction = false
          }
        },
      }
    }

    ctx.provide('store', {
      register(_caller: Context, prefix: string, tables: readonly StoreTableDef[]): StoreHandle {
        return makeHandle(prefix, tables)
      },
    })

    // Release the file handle when the host tree unloads; on Windows an open
    // handle would block removing the home directory.
    ctx.effect(() => () => { db.close() })
  },
  { inject: ['snapRailHome'] },
)

export default storePlugin
