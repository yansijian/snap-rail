/**
 * The production-stats contract: the shift vocabulary, the counting
 * binding's settings key, and the snapshot shape broadcast on the
 * `production/stats-changed` frame. Pure data + zod — the page and the
 * host counter (`./stats`) share this module, and it must stay free of
 * node- and host-side imports.
 *
 * @module @snap-rail/process-production/contract
 */

import { z } from 'zod'

/** The three eight-hour shifts: 8–16 早班, 16–24 中班, 0–8 晚班. */
export type ShiftName = 'morning' | 'middle' | 'night'

/** Window bounds per shift (local wall-clock hours), for display. */
export const SHIFT_WINDOWS: Readonly<Record<ShiftName, { startHour: number, endHour: number }>> = {
  morning: { startHour: 8, endHour: 16 },
  middle: { startHour: 16, endHour: 24 },
  night: { startHour: 0, endHour: 8 },
}

/** Settings key holding the counting point's address in settings.json. */
export const COUNT_BINDING_KEY = 'production.countBinding'

/** The counting binding as persisted in settings.json: the same
 * (device, group, name) triple that addresses field points. */
export const countBindingSchema = z.object({
  device: z.string().min(1),
  group: z.string().min(1),
  name: z.string().min(1),
}).strict()

export type CountBinding = z.infer<typeof countBindingSchema>

/** The binding used while settings.json carries none. */
export const DEFAULT_COUNT_BINDING: CountBinding = { device: 'plc1', group: '产量', name: '产量计数' }

/** One accumulated (date, shift) bucket as the snapshot lists it. */
export interface ProductionShiftRow {
  /** Composite `<local date>:<shift>` key, e.g. `2026-08-30:morning`. */
  shiftKey: string
  shift: ShiftName
  /** The bucket's local date, `YYYY-MM-DD`. */
  date: string
  count: number
  /** Epoch ms of the last flush that touched this row. */
  updatedAt: number
}

/** The login-anchored shift context the production page displays. */
export interface ProductionAnchor {
  operator: string
  /** Login epoch ms — the shift anchor; only a re-login moves it. */
  loginAt: number
  shift: ShiftName
  shiftKey: string
  /** The anchored shift's accumulated count (live). */
  count: number
}

/** One hour-aligned chart bucket. */
export interface ProductionHourBucket {
  /** Epoch ms of the bucket's hour start (local-aligned). */
  hourStart: number
  count: number
}

/** The full `production/stats-changed` frame payload. */
export interface ProductionStatsSnapshot {
  /** `null` while nobody is signed on. */
  anchor: ProductionAnchor | null
  /** The most recent shift rows (newest first). */
  shifts: readonly ProductionShiftRow[]
  /** The most recent hour buckets (oldest first). */
  hours: readonly ProductionHourBucket[]
}

const shiftNameSchema = z.enum(['morning', 'middle', 'night'])

const shiftRowSchema = z.object({
  shiftKey: z.string().min(1),
  shift: shiftNameSchema,
  date: z.string().min(1),
  count: z.number(),
  updatedAt: z.number(),
}).strict()

const anchorSchema = z.object({
  operator: z.string().min(1),
  loginAt: z.number(),
  shift: shiftNameSchema,
  shiftKey: z.string().min(1),
  count: z.number(),
}).strict()

declare module '@snap-rail/protocol' {
  interface FrameMap {
    /// The full stats snapshot, broadcast every flush cycle (also when idle,
    /// so a fresh renderer gets its initial value).
    'production/stats-changed': ProductionStatsSnapshot
  }
}

/** Consumer-side validation of a `production/stats-changed` payload. */
export const productionStatsSnapshotSchema = z.object({
  anchor: z.union([anchorSchema, z.null()]),
  shifts: z.array(shiftRowSchema),
  hours: z.array(z.object({ hourStart: z.number(), count: z.number() }).strict()),
}).strict() satisfies z.ZodType<ProductionStatsSnapshot>

/** Local `YYYY-MM-DD` of `epochMs` — the date component of a shift key. */
export function localDateString(epochMs: number): string {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
