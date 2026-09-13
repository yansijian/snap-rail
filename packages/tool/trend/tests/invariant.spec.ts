/**
 * The production-stats invariant sidecar: the "always-true" rules of the
 * persisted tables — non-negative counts, hour-aligned buckets, well-formed
 * shift keys, the single anchor row — hold on real data and every breach
 * surfaces as a named violation.
 *
 * @module snap-rail/trend/tests/invariant.spec
 */

import { describe, expect, it } from 'vitest'
import { collectProductionViolations } from '../src/invariant.ts'
import type { ProductionInvariantViolation } from '../src/invariant.ts'
import type { anchor, hours, shifts } from '../src/tables.ts'

type ShiftRow = typeof shifts.$inferSelect
type HourRow = typeof hours.$inferSelect
type AnchorRow = typeof anchor.$inferSelect

const shift = (over: Partial<ShiftRow>): ShiftRow => ({
  shiftKey: '2026-09-13:morning',
  count: 0,
  lastSample: null,
  binding: null,
  updatedAt: 0,
  ...over,
})

const hour = (over: Partial<HourRow>): HourRow => ({
  hourStart: 0,
  count: 0,
  updatedAt: 0,
  ...over,
})

const anchorRow = (over: Partial<AnchorRow>): AnchorRow => ({
  id: 1,
  operator: 'op-1',
  loginAt: 0,
  shiftKey: '2026-09-13:morning',
  ...over,
})

const codesOf = (violations: readonly ProductionInvariantViolation[]): string[] =>
  violations.map(violation => `${violation.table}/${violation.key}`)

describe('production invariant sidecar', () => {
  it('accepts honest buckets, keys, and anchor', () => {
    const violations = collectProductionViolations(
      [
        shift({ shiftKey: '2026-09-13:morning', count: 120, updatedAt: 10 }),
        shift({ shiftKey: '2026-09-13:night', count: 3, updatedAt: 10 }),
      ],
      [hour({ hourStart: 3_600_000, count: 40 })],
      [anchorRow({})],
    )
    expect(violations).toEqual([])
  })

  it('rejects negative counts, off-grid buckets, and malformed keys', () => {
    const violations = collectProductionViolations(
      [shift({ shiftKey: '2026-09-13:morning', count: -1 }), shift({ shiftKey: 'bogus', count: 1 })],
      [hour({ hourStart: 1_800_000 }), hour({ hourStart: 7_200_000, count: -5 })],
      [],
    )
    expect(codesOf(violations)).toEqual([
      'shifts/2026-09-13:morning',
      'shifts/bogus',
      'hours/1800000',
      'hours/7200000',
    ])
  })

  it('enforces the single well-formed anchor row', () => {
    const violations = collectProductionViolations(
      [],
      [],
      [anchorRow({}), anchorRow({ id: 2, shiftKey: 'nope' })],
    )
    expect(violations).toHaveLength(2)
    expect(violations.some(violation => violation.table === 'anchor' && violation.key === '2')).toBe(true)
    expect(violations.some(violation => violation.table === 'anchor' && violation.detail.includes('不合法'))).toBe(true)
  })

  it('accepts an absent anchor (nobody has logged in yet)', () => {
    expect(collectProductionViolations([], [], [])).toEqual([])
  })
})
