/**
 * 班产统计 (shift production stats): the host-side counter behind this
 * package's production page (实际产量). It follows the counting binding
 * (the same `production.countBinding` settings key the page's settings
 * dialog writes) over the field seam's `field/point-update` topic and
 * accumulates positive deltas into three eight-hour shift buckets (8–16
 * 早班, 16–24 中班, 0–8 晚班), persisted in the store — page switches,
 * logouts, and restarts never lose a count.
 *
 * A shift is anchored at login time: the whole login session counts into
 * the bucket `shiftKeyOf(loginAt)` and only a re-login re-picks. A restart
 * with the operator still signed on restores the persisted anchor, so the
 * shift survives reboot; samples while nobody is signed on count nowhere.
 *
 * The renderer is a pure projection (this package's page): every flush tick
 * broadcasts the full snapshot on the `production/stats-changed` frame
 * (also when idle, so a freshly booted renderer gets its initial state
 * within one tick). The payload contract lives in `./contract.ts` —
 * business-owned, not a protocol method.
 *
 * @module @snap-rail/suite-terminal-ops/production/stats
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the field contracts
// (point triples, topic payload schemas) alongside the runtime service.
import '@snap-rail/field'
import { z } from 'zod'
import { desc, eq, lt, sql } from 'drizzle-orm'
import { pointKey } from '@snap-rail/field'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import '@snap-rail/store'
import {
  COUNT_BINDING_KEY,
  DEFAULT_COUNT_BINDING,
  countBindingSchema,
  productionStatsSnapshotSchema,
  type CountBinding,
  type ProductionHourBucket,
  type ProductionShiftRow,
  type ProductionStatsSnapshot,
} from './production-contract.ts'
import { dateOfShiftKey, shiftKeyOf, shiftOf, shiftOfKey } from './production-shift.ts'
import { PRODUCTION_SCHEMA, anchor, hours, shifts } from './stats-tables.ts'

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
  lastSample: string | null
  binding: string | null
}

/**
 * The production-stats plugin; mount after rpc, settings, store, timer,
 * and the field seam.
 */
const productionStatsPlugin: Plugin.Object<ProductionStatsConfig> = {
  name: 'production-stats',
  inject: ['rpc', 'settings', 'store', 'timer', 'topic'],
  Config: productionStatsConfigSchema,
  apply(ctx: Context, config: ProductionStatsConfig): void {
    const rpc: GatewayService = ctx.rpc
    rpc.claimDomain(ctx, 'production')
    rpc.frame(ctx, 'production/stats-changed', { payload: productionStatsSnapshotSchema })
    const settings: SettingsService = ctx.settings
    const store = ctx.store.register(ctx, 'production_stats', PRODUCTION_SCHEMA)

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
      const row = store.select({
        count: shifts.count,
        lastSample: shifts.lastSample,
        binding: shifts.binding,
      }).from(shifts).where(eq(shifts.shiftKey, shiftKey)).get() satisfies ShiftRow | undefined
      count = row?.count ?? 0
      lastSample = row !== undefined
        && row.lastSample !== null
        && row.binding !== null
        && row.binding === pointKey(binding)
        ? decodeSample(row.lastSample)
        : null
    }

    const flush = (): void => {
      if (session !== null) {
        store.insert(shifts).values({
          shiftKey: session.shiftKey,
          count: Math.floor(count),
          lastSample: lastSample === null ? null : encodeSample(lastSample),
          binding: pointKey(binding),
          updatedAt: Date.now(),
        }).onConflictDoUpdate({
          target: shifts.shiftKey,
          set: {
            count: sql`excluded.count`,
            lastSample: sql`excluded.last_sample`,
            binding: sql`excluded.binding`,
            updatedAt: sql`excluded.updated_at`,
          },
        }).run()
        store.insert(anchor).values({
          id: 1,
          operator: session.operator,
          loginAt: session.loginAt,
          shiftKey: session.shiftKey,
        }).onConflictDoUpdate({
          target: anchor.id,
          set: {
            operator: sql`excluded.operator`,
            loginAt: sql`excluded.login_at`,
            shiftKey: sql`excluded.shift_key`,
          },
        }).run()
      }
      for (const [hourStart, delta] of hourDeltas) {
        store.insert(hours).values({
          hourStart,
          count: Math.floor(delta),
          updatedAt: Date.now(),
        }).onConflictDoUpdate({
          target: hours.hourStart,
          set: {
            count: sql`${hours.count} + excluded.count`,
            updatedAt: sql`excluded.updated_at`,
          },
        }).run()
      }
      hourDeltas.clear()
      store.delete(hours).where(lt(hours.hourStart, Date.now() - HOUR_RETENTION_MS)).run()
      dirty = false
    }

    const snapshot = (): ProductionStatsSnapshot => {
      const rows = store.select({
        shiftKey: shifts.shiftKey,
        count: shifts.count,
        updatedAt: shifts.updatedAt,
      }).from(shifts).orderBy(desc(shifts.updatedAt)).limit(SHIFT_ROW_LIMIT).all()
      const shiftRows: ProductionShiftRow[] = []
      if (session !== null) {
        // The anchored row carries the live in-memory count.
        shiftRows.push({
          shiftKey: session.shiftKey,
          shift: shiftOf(session.loginAt),
          date: dateOfShiftKey(session.shiftKey),
          count: Math.floor(count),
          updatedAt: Date.now(),
        })
      }
      for (const row of rows) {
        if (session !== null && row.shiftKey === session.shiftKey) continue
        const shift = shiftOfKey(row.shiftKey)
        if (shift === undefined) continue
        shiftRows.push({
          shiftKey: row.shiftKey,
          shift,
          date: dateOfShiftKey(row.shiftKey),
          count: row.count,
          updatedAt: row.updatedAt,
        })
      }
      const hourRows = store.select({
        hourStart: hours.hourStart,
        count: hours.count,
      }).from(hours).orderBy(desc(hours.hourStart)).limit(HOUR_BUCKET_LIMIT).all()
        .map((row): ProductionHourBucket => ({ hourStart: row.hourStart, count: row.count }))
        .reverse()
      return {
        anchor: session === null ? null : {
          operator: session.operator,
          loginAt: session.loginAt,
          shift: shiftOf(session.loginAt),
          shiftKey: session.shiftKey,
          count: Math.floor(count),
        },
        shifts: shiftRows,
        hours: hourRows,
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
      const persisted = store.select({
        operator: anchor.operator,
        loginAt: anchor.loginAt,
        shiftKey: anchor.shiftKey,
      }).from(anchor).where(eq(anchor.id, 1)).get()
      if (persisted !== undefined && persisted.operator === operator) {
        // The session survived a restart; keep the original login anchor —
        // only a re-login re-picks the shift.
        session = { operator, loginAt: persisted.loginAt, shiftKey: persisted.shiftKey }
        loadShiftRow(persisted.shiftKey)
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
    // the baseline; unmapped bindings never produce samples. The subscription
    // is unfiltered (the binding is settings-driven and may change under the
    // fixed gate), so the listener narrows by the current binding itself. ----
    ctx.topic.subscribe<{ device: string, group: string, name: string, value: number | bigint | string | boolean | null, time: number }>(
      ctx,
      'field/point-update',
      undefined,
      sample => {
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
      },
    )

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
