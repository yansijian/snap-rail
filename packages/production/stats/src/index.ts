/**
 * 班产统计 (shift production stats): the host-side counter behind the
 * production page's 实际产量. It follows the counting binding (the same
 * `production.countBinding` settings key the renderer's 产量采集 page
 * writes) over the field seam's `point/updated` events and accumulates
 * positive deltas into three eight-hour shift buckets (8–16 早班, 16–24
 * 中班, 0–8 晚班), persisted in the store — page switches, logouts, and
 * restarts never lose a count.
 *
 * A shift is anchored at login time: the whole login session counts into
 * the bucket `shiftKeyOf(loginAt)` and only a re-login re-picks. A restart
 * with the operator still signed on restores the persisted anchor, so the
 * shift survives reboot; samples while nobody is signed on count nowhere.
 *
 * The renderer is a pure projection: every flush tick broadcasts the full
 * snapshot on the `production/stats-changed` frame (also when idle, so a
 * freshly booted renderer gets its initial state within one tick). The
 * payload contract lives in `./contract.ts` — business-owned, not a
 * protocol method.
 *
 * @module @snap-rail/production-stats
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the `point/updated`
// event declaration alongside the runtime service.
import '@snap-rail/field'
import { z } from 'zod'
import { pointKey } from '@snap-rail/field'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import '@snap-rail/store'
import type { StoreHandle } from '@snap-rail/store'
import {
  COUNT_BINDING_KEY,
  DEFAULT_COUNT_BINDING,
  countBindingSchema,
  productionStatsSnapshotSchema,
  type CountBinding,
  type ProductionHourBucket,
  type ProductionShiftRow,
  type ProductionStatsSnapshot,
} from './contract.ts'
import { dateOfShiftKey, shiftKeyOf, shiftOf, shiftOfKey } from './shift.ts'
import { PRODUCTION_TABLES } from './tables.ts'

/** Settings key holding the signed-on operator (same source as station-rpc). */
const OPERATOR_KEY = 'session.operatorId'

/** How many shift rows / hour buckets the snapshot carries. */
const SHIFT_ROW_LIMIT = 9
const HOUR_BUCKET_LIMIT = 48
/** Hour buckets older than this are pruned on flush. */
const HOUR_RETENTION_MS = 48 * 3_600_000

/** Plugin config: the flush/broadcast cadence. */
export interface ProductionStatsConfig {
  /** Milliseconds between flush-and-broadcast ticks. */
  flushMs: number
}

const productionStatsConfigSchema = z.object({
  flushMs: z.number().int().min(10).default(1000),
}).strict() satisfies z.ZodType<ProductionStatsConfig>

/** Round-trip a baseline sample through the store's TEXT column without
 * losing 64-bit counter precision. */
function encodeSample(sample: number | bigint): string {
  return String(sample)
}

function decodeSample(raw: string): number | bigint {
  return /^\d+$/.test(raw) ? BigInt(raw) : Number(raw)
}

/** A stored shift row as the counter reads it back. */
interface ShiftRow {
  count: number
  last_sample: string | null
  binding: string | null
}

/**
 * The production-stats plugin; mount after rpc, settings, store, timer,
 * and the field seam.
 */
const productionStatsPlugin: Plugin.Object<ProductionStatsConfig> = {
  name: 'production-stats',
  inject: ['rpc', 'settings', 'store', 'timer'],
  Config: productionStatsConfigSchema,
  apply(ctx: Context, config: ProductionStatsConfig): void {
    const rpc: GatewayService = ctx.rpc
    rpc.claimDomain(ctx, 'production')
    rpc.frame(ctx, 'production/stats-changed', { payload: productionStatsSnapshotSchema })
    const settings: SettingsService = ctx.settings
    const store: StoreHandle = ctx.store.register(ctx, 'production_stats', PRODUCTION_TABLES)

    // All mutable state rides this apply-scope closure (the uiSlots lesson:
    // traceable context proxies rebind `this` on every method access).
    let binding: CountBinding = DEFAULT_COUNT_BINDING
    /** The login-anchored session; `null` while nobody is signed on. */
    let session: { operator: string, loginAt: number, shiftKey: string } | null = null
    /** The anchored shift's live count. */
    let count = 0
    /** Baseline device counter value; `null` means the next sample only seeds. */
    let lastSample: number | bigint | null = null
    /** Hour deltas accumulated since the last flush. */
    const hourDeltas = new Map<number, number>()
    let dirty = false

    const adoptBinding = (value: unknown): void => {
      const parsed = countBindingSchema.safeParse(value)
      if (!parsed.success) return
      if (pointKey(parsed.data) === pointKey(binding)) return
      binding = parsed.data
      // A different address has an unrelated counter scale: re-seed.
      lastSample = null
    }

    /** Load the anchored shift's row: its count continues, and its stored
     * baseline stays reusable only while the binding still matches. */
    const loadShiftRow = (shiftKey: string): void => {
      const row = store.get<ShiftRow>(
        `SELECT count, last_sample, binding FROM ${store.table('shifts')} WHERE shift_key = ?`,
        [shiftKey])
      count = row?.count ?? 0
      lastSample = row !== undefined
        && row.last_sample !== null
        && row.binding !== null
        && row.binding === pointKey(binding)
        ? decodeSample(row.last_sample)
        : null
    }

    const flush = (): void => {
      if (session !== null) {
        store.run(
          `INSERT INTO ${store.table('shifts')} (shift_key, count, last_sample, binding, updated_at) `
          + 'VALUES (?, ?, ?, ?, ?) '
          + 'ON CONFLICT(shift_key) DO UPDATE SET count = excluded.count, '
          + 'last_sample = excluded.last_sample, binding = excluded.binding, updated_at = excluded.updated_at',
          [session.shiftKey, Math.floor(count),
            lastSample === null ? null : encodeSample(lastSample), pointKey(binding), Date.now()],
        )
        store.run(
          `INSERT INTO ${store.table('anchor')} (id, operator, login_at, shift_key) VALUES (1, ?, ?, ?) `
          + 'ON CONFLICT(id) DO UPDATE SET operator = excluded.operator, '
          + 'login_at = excluded.login_at, shift_key = excluded.shift_key',
          [session.operator, session.loginAt, session.shiftKey],
        )
      }
      for (const [hourStart, delta] of hourDeltas) {
        store.run(
          `INSERT INTO ${store.table('hours')} (hour_start, count, updated_at) VALUES (?, ?, ?) `
          + 'ON CONFLICT(hour_start) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at',
          [hourStart, Math.floor(delta), Date.now()],
        )
      }
      hourDeltas.clear()
      store.run(`DELETE FROM ${store.table('hours')} WHERE hour_start < ?`, [Date.now() - HOUR_RETENTION_MS])
      dirty = false
    }

    const snapshot = (): ProductionStatsSnapshot => {
      const rows = store.all<{ shift_key: string, count: number, updated_at: number }>(
        `SELECT shift_key, count, updated_at FROM ${store.table('shifts')} `
        + `ORDER BY updated_at DESC LIMIT ${SHIFT_ROW_LIMIT}`,
      )
      const shifts: ProductionShiftRow[] = []
      if (session !== null) {
        // The anchored row carries the live in-memory count.
        shifts.push({
          shiftKey: session.shiftKey,
          shift: shiftOf(session.loginAt),
          date: dateOfShiftKey(session.shiftKey),
          count: Math.floor(count),
          updatedAt: Date.now(),
        })
      }
      for (const row of rows) {
        if (session !== null && row.shift_key === session.shiftKey) continue
        const shift = shiftOfKey(row.shift_key)
        if (shift === undefined) continue
        shifts.push({
          shiftKey: row.shift_key,
          shift,
          date: dateOfShiftKey(row.shift_key),
          count: row.count,
          updatedAt: row.updated_at,
        })
      }
      const hours = store.all<{ hour_start: number, count: number }>(
        `SELECT hour_start, count FROM ${store.table('hours')} `
        + `ORDER BY hour_start DESC LIMIT ${HOUR_BUCKET_LIMIT}`,
      )
        .map((row): ProductionHourBucket => ({ hourStart: row.hour_start, count: row.count }))
        .reverse()
      return {
        anchor: session === null ? null : {
          operator: session.operator,
          loginAt: session.loginAt,
          shift: shiftOf(session.loginAt),
          shiftKey: session.shiftKey,
          count: Math.floor(count),
        },
        shifts,
        hours,
      }
    }

    /** Flush what changed, then always broadcast — the unconditional frame
     * doubles as the heartbeat a freshly booted renderer reads its initial
     * snapshot from. */
    const tick = (): void => {
      if (dirty) flush()
      rpc.broadcast('production/stats-changed', snapshot())
    }

    const login = (operator: string): void => {
      const loginAt = Date.now()
      session = { operator, loginAt, shiftKey: shiftKeyOf(loginAt) }
      // A row for this shift continues (shift handover); a fresh shift
      // simply starts from the device's current value.
      loadShiftRow(session.shiftKey)
      dirty = true
      tick()
    }

    const logout = (): void => {
      // Flush while the session is still known so the final count and
      // baseline land in the shift row.
      if (dirty) flush()
      session = null
      count = 0
      lastSample = null
      tick()
    }

    // ---- boot: settings state + persisted anchor ----
    adoptBinding(settings.get(COUNT_BINDING_KEY))
    const operator = settings.get<string | null>(OPERATOR_KEY) ?? null
    if (operator !== null) {
      const persisted = store.get<{ operator: string, login_at: number, shift_key: string }>(
        `SELECT operator, login_at, shift_key FROM ${store.table('anchor')} WHERE id = 1`)
      if (persisted !== undefined && persisted.operator === operator) {
        // The session survived a restart; keep the original login anchor —
        // only a re-login re-picks the shift.
        session = { operator, loginAt: persisted.login_at, shiftKey: persisted.shift_key }
        loadShiftRow(persisted.shift_key)
      } else {
        login(operator)
      }
    }

    // ---- live: session transitions and binding changes ride the settings
    // seam (station-rpc's session.login/logout write these keys). ----
    ctx.on('settings/changed', (key, value) => {
      if (key === OPERATOR_KEY) {
        const next = typeof value === 'string' && value.trim() !== '' ? value : null
        if (next === null) logout()
        else login(next)
        return
      }
      if (key === COUNT_BINDING_KEY) adoptBinding(value)
    })

    // ---- live: the counter itself. Positive deltas only; a device counter
    // reset (negative delta) is ignored; an abnormal (null) sample re-seeds
    // the baseline; unmapped bindings never produce samples. ----
    ctx.on('point/updated', sample => {
      if (session === null) return
      if (sample.device !== binding.device || sample.group !== binding.group
        || sample.name !== binding.name) return
      const value = sample.value
      if (value === null) {
        lastSample = null
        return
      }
      if (typeof value !== 'number' && typeof value !== 'bigint') return
      if (lastSample !== null) {
        const delta = Number(value) - Number(lastSample)
        if (delta > 0) {
          count += delta
          const hourStart = new Date().setMinutes(0, 0, 0)
          hourDeltas.set(hourStart, (hourDeltas.get(hourStart) ?? 0) + delta)
          dirty = true
        }
      }
      lastSample = value
    })

    ctx.interval(tick, config.flushMs)

    // Best-effort final flush when the host tree unloads (the store's own
    // fiber disposes after this one — reverse mount order).
    ctx.effect(() => () => {
      try {
        flush()
      } catch {
        // The database may already be closing; the last tick's flush stands.
      }
    })
  },
}

export default productionStatsPlugin
export { shiftKeyOf, shiftOf }
