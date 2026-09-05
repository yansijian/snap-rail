/**
 * Binding condition matching: does a published topic payload satisfy a
 * profile binding's AND-combined conditions? Equality compares within type
 * (bigint-exact) and across the numeric pair (number ↔ bigint); ordering
 * operators need two numbers or two strings — a type mismatch is simply a
 * non-match, never an error. Pure module.
 *
 * @module @snap-rail/trend/bindings
 */

import type { TrendBinding } from './contract.ts'

type ComparisonValue = boolean | number | bigint | string

function isNumeric(value: ComparisonValue): boolean {
  return typeof value === 'number' || typeof value === 'bigint'
}

function compareValues(left: ComparisonValue, op: '==' | '!=' | '>' | '<' | '>=' | '<=', right: ComparisonValue): boolean {
  switch (op) {
    case '==':
      if (typeof left === typeof right) return left === right
      if (isNumeric(left) && isNumeric(right)) return Number(left) === Number(right)
      return false
    case '!=':
      if (typeof left === typeof right) return left !== right
      if (isNumeric(left) && isNumeric(right)) return Number(left) !== Number(right)
      return true
    default:
      if (typeof left === 'string' && typeof right === 'string') {
        return compareOrdered(left.localeCompare(right), op)
      }
      if (isNumeric(left) && isNumeric(right)) {
        return compareOrdered(Number(left) - Number(right), op)
      }
      return false
  }
}

function compareOrdered(ordered: number, op: '>' | '<' | '>=' | '<='): boolean {
  switch (op) {
    case '>': return ordered > 0
    case '<': return ordered < 0
    case '>=': return ordered >= 0
    case '<=': return ordered <= 0
  }
}

/** Every condition must hold; a missing payload field is a non-match. */
export function matchesBinding(binding: TrendBinding, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  return binding.all.every(condition => {
    const actual = record[condition.field]
    if (actual === undefined || actual === null) return false
    if (typeof actual === 'object' && typeof condition.value !== 'object') return false
    return compareValues(actual as ComparisonValue, condition.op, condition.value)
  })
}
