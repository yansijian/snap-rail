import { describe, expect, it } from 'vitest'
import { matchesBinding } from '../src/bindings.ts'
import type { TrendBinding } from '../src/contract.ts'

const pointOn: TrendBinding = {
  topic: 'field/point-update',
  all: [
    { field: 'name', op: '==', value: '温度1' },
    { field: 'value', op: '==', value: true },
  ],
}

describe('binding matcher', () => {
  it('requires every condition to hold (点 X 为 ON)', () => {
    expect(matchesBinding(pointOn, { device: 'plc1', group: '布尔', name: '温度1', value: true, time: 1 })).toBe(true)
    expect(matchesBinding(pointOn, { name: '温度1', value: false })).toBe(false)
    expect(matchesBinding(pointOn, { name: '温度2', value: true })).toBe(false)
  })

  it('treats a missing payload field as a non-match, never an error', () => {
    expect(matchesBinding(pointOn, { name: '温度1' })).toBe(false)
    expect(matchesBinding(pointOn, undefined)).toBe(false)
    expect(matchesBinding(pointOn, 'scalar')).toBe(false)
  })

  it('compares int64 payloads numerically against number literals', () => {
    const binding: TrendBinding = { topic: 't', all: [{ field: 'v', op: '==', value: 42 }] }
    expect(matchesBinding(binding, { v: 42n })).toBe(true)
    expect(matchesBinding(binding, { v: 43n })).toBe(false)
    // Boolean true is not the number 1 here: cross-boolean equality is strict.
    expect(matchesBinding({ topic: 't', all: [{ field: 'v', op: '==', value: 1 }] }, { v: true })).toBe(false)
  })

  it('supports ordering on numbers and strings', () => {
    const numeric: TrendBinding = { topic: 't', all: [{ field: 'n', op: '>', value: 5 }] }
    expect(matchesBinding(numeric, { n: 6.5 })).toBe(true)
    expect(matchesBinding(numeric, { n: 5 })).toBe(false)
    expect(matchesBinding(numeric, { n: 6n })).toBe(true)

    const textual: TrendBinding = { topic: 't', all: [{ field: 's', op: '>=', value: 'b' }] }
    expect(matchesBinding(textual, { s: 'c' })).toBe(true)
    expect(matchesBinding(textual, { s: 'a' })).toBe(false)
    // Ordering across mismatched types is a non-match.
    expect(matchesBinding(numeric, { n: '6' })).toBe(false)
  })
})
