/**
 * Shift bucketing for production stats: the three eight-hour windows of a
 * station day. A login session's shift is fixed by its login time — the
 * whole session counts into that one bucket, and only a re-login re-picks.
 *
 * @module @snap-rail/suite-terminal-ops/production-shift
 */

import { localDateString, type ShiftName } from './production-contract.ts'

/** Which eight-hour window `epochMs` falls into (local time). */
export function shiftOf(epochMs: number): ShiftName {
  const hour = new Date(epochMs).getHours()
  if (hour >= 8 && hour < 16) return 'morning'
  if (hour >= 16) return 'middle'
  return 'night'
}

/** The shift bucket key `<local YYYY-MM-DD>:<shift>` for `epochMs`. */
export function shiftKeyOf(epochMs: number): string {
  return `${localDateString(epochMs)}:${shiftOf(epochMs)}`
}

/** The `ShiftName` suffix of a shift key, or `undefined` when malformed. */
export function shiftOfKey(shiftKey: string): ShiftName | undefined {
  const suffix = shiftKey.slice(shiftKey.indexOf(':') + 1)
  return suffix === 'morning' || suffix === 'middle' || suffix === 'night' ? suffix : undefined
}

/** The local date component (`YYYY-MM-DD`) of a shift key. */
export function dateOfShiftKey(shiftKey: string): string {
  const colon = shiftKey.indexOf(':')
  return colon === -1 ? shiftKey : shiftKey.slice(0, colon)
}
