/**
 * The production-stats invariant sidecar: a diagnostic plugin that checks
 * the "always-true" rules of the persisted `production_stats` tables and
 * reports violations as data — never throws, never repairs, never writes.
 * Mount it explicitly through a `plugins.yml` row (`@snap-rail/trend/invariant`)
 * when a customer reports numbers that smell wrong; unlisted it costs
 * nothing and never ships in a default composition.
 *
 * Checked rules: counts are non-negative; hour buckets align to hour
 * boundaries; shift keys parse to a valid `<date>:<shift>` form; the login
 * anchor is the single well-formed row the app enforces.
 *
 * @module @snap-rail/trend/invariant
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/store'
import { dateOfShiftKey, shiftOfKey } from './shift.ts'
import { PRODUCTION_SCHEMA, anchor, hours, shifts } from './tables.ts'

/** One persisted shift-counter row (the store's select shape). */
type ShiftRow = typeof shifts.$inferSelect
/** One persisted hour-bucket row. */
type HourRow = typeof hours.$inferSelect
/** One persisted login-anchor row. */
type AnchorRow = typeof anchor.$inferSelect

/** One broken "always-true" rule of the production tables. */
export interface ProductionInvariantViolation {
  /** The table the violation attaches to. */
  table: 'shifts' | 'hours' | 'anchor'
  /** The row key (shiftKey / hourStart / id). */
  key: string
  /** Human-readable detail (Chinese, operator-facing). */
  detail: string
}

const HOUR_MS = 3_600_000

/** The date component of a shift key is a real `YYYY-MM-DD`. */
function wellFormedDate(value: string): boolean {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(value)
  return match !== null && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/**
 * Check the production tables' always-true rules and return every violation.
 * Pure read over already-selected rows — nothing is written.
 *
 * @param shiftRows - all persisted shift rows.
 * @param hourRows - all persisted hour buckets.
 * @param anchorRows - the persisted login-anchor rows (absent is legal).
 */
export function collectProductionViolations(
  shiftRows: readonly ShiftRow[],
  hourRows: readonly HourRow[],
  anchorRows: readonly AnchorRow[],
): readonly ProductionInvariantViolation[] {
  const violations: ProductionInvariantViolation[] = []

  for (const row of shiftRows) {
    const shift = shiftOfKey(row.shiftKey)
    if (shift === undefined) {
      violations.push({ table: 'shifts', key: row.shiftKey, detail: `班次键 ${row.shiftKey} 不是合法的 <日期>:<班次> 形式` })
      continue
    }
    if (!wellFormedDate(dateOfShiftKey(row.shiftKey))) {
      violations.push({ table: 'shifts', key: row.shiftKey, detail: `班次键 ${row.shiftKey} 的日期段不是 YYYY-MM-DD` })
    }
    if (row.count < 0) {
      violations.push({ table: 'shifts', key: row.shiftKey, detail: `班次 ${row.shiftKey} 的计数 ${row.count} 为负` })
    }
  }

  for (const row of hourRows) {
    if (row.hourStart % HOUR_MS !== 0) {
      violations.push({ table: 'hours', key: String(row.hourStart), detail: `小时桶 ${row.hourStart} 未对齐到整点` })
    }
    if (row.count < 0) {
      violations.push({ table: 'hours', key: String(row.hourStart), detail: `小时桶 ${row.hourStart} 的计数 ${row.count} 为负` })
    }
  }

  // The anchor is always row 1 (the app enforces it); an absent anchor is
  // legal — nobody has logged in yet.
  for (const row of anchorRows) {
    if (row.id !== 1) {
      violations.push({ table: 'anchor', key: String(row.id), detail: `登录锚点出现了 id=${row.id} 的多余行` })
    }
    if (shiftOfKey(row.shiftKey) === undefined) {
      violations.push({ table: 'anchor', key: row.shiftKey, detail: `登录锚点的班次键 ${row.shiftKey} 不合法` })
    }
  }

  return violations
}

/** The invariant sidecar plugin; mount after the store seam is live. */
const productionInvariantPlugin: Plugin.Object<void> = {
  name: 'production-invariant',
  inject: ['store'],
  apply(ctx: Context): void {
    const db = ctx.store.register(ctx, 'production_stats', PRODUCTION_SCHEMA)
    void Promise.all([
      db.select().from(shifts),
      db.select().from(hours),
      db.select().from(anchor),
    ]).then(([shiftRows, hourRows, anchorRows]) => {
      const violations = collectProductionViolations(shiftRows, hourRows, anchorRows)
      if (violations.length === 0) return
      const logger = ctx.logger('production-invariant')
      for (const violation of violations) logger.warn?.(`${violation.table}/${violation.key}: ${violation.detail}`)
    }).catch(cause => {
      ctx.logger('production-invariant').error?.(cause)
    })
  },
}

export default productionInvariantPlugin
