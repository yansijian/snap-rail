/**
 * Tagged TEXT encoding for sample values in the trend store: SQLite has no
 * bigint/boolean column affinity that round-trips losslessly, so every value
 * rides a two-char tag (`b:`, `i:`, `n:`, `s:`, `~`) — 64-bit counters stay
 * exact, `42` and `42n` stay distinct, and decode never guesses. Pure
 * module: shared by the host recorder and any analysis code.
 *
 * @module @snap-rail/trend/values
 */

import type { TrendValue } from './contract.ts'

/** Encode one value for the store's TEXT column. */
export function encodeValue(value: TrendValue): string {
  switch (typeof value) {
    case 'object': return '~'
    case 'boolean': return value ? 'b:1' : 'b:0'
    case 'bigint': return `i:${value.toString()}`
    case 'number': return `n:${value}`
    default: return `s:${value}`
  }
}

/** Decode one stored value; a corrupt tag is a readable failure (writes
 * always encode, so this only guards hand-edited databases). */
export function decodeValue(raw: string): TrendValue {
  if (raw === '~') return null
  const tag = raw.slice(0, 2)
  const body = raw.slice(2)
  switch (tag) {
    case 'b:': return body === '1'
    case 'i:': return BigInt(body)
    case 'n:': return Number(body)
    case 's:': return body
    default: throw new Error(`trend: corrupt stored value "${raw.slice(0, 32)}"`)
  }
}

/**
 * The numeric projection the feature extractor works on: booleans count as
 * 1/0 (a bool point's run-up is a slope), bigints demote to doubles, strings
 * and nulls carry no magnitude (`null` — the series simply skips them).
 */
export function numericValue(value: TrendValue): number | null {
  switch (typeof value) {
    case 'boolean': return value ? 1 : 0
    case 'bigint': return Number(value)
    case 'number': return value
    default: return null
  }
}
