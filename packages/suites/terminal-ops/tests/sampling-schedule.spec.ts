import { describe, expect, it } from 'vitest'
import { nextDue, parseCron } from '../src/sampling-schedule.ts'

describe('parseCron', () => {
  it('parses wildcard minute/hour with dom/month/dow as *', () => {
    const spec = parseCron('*/30 * * * *')
    expect([...spec.minutes].length).toBe(2)
    expect(spec.minutes.has(0)).toBe(true)
    expect(spec.minutes.has(30)).toBe(true)
    expect(spec.hours.size).toBe(24)
  })

  it('parses lists and ranges with steps', () => {
    const spec = parseCron('0,30 8-20/4 * * *')
    expect([...spec.minutes].sort((a, b) => a - b)).toEqual([0, 30])
    expect([...spec.hours].sort((a, b) => a - b)).toEqual([8, 12, 16, 20])
  })

  it('rejects non-five-field expressions', () => {
    expect(() => parseCron('*/30 * * *')).toThrow(/5 个字段/)
  })

  it('rejects variation outside minute/hour', () => {
    expect(() => parseCron('* * 1 * *')).toThrow(/日\/月\/周/)
  })

  it('rejects out-of-range values and bad steps', () => {
    expect(() => parseCron('61 * * * *')).toThrow(/越界/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/步长/)
    expect(() => parseCron('abc * * * *')).toThrow(/不合法/)
  })
})

describe('nextDue', () => {
  it('finds the next matching minute strictly after the anchor', () => {
    const spec = parseCron('*/30 * * * *')
    const from = new Date('2026-08-27T10:05:00')
    expect(new Date(nextDue(spec, from)).getMinutes()).toBe(30)
    // A due minute itself is not "next".
    const atDue = new Date('2026-08-27T10:30:00')
    expect(new Date(nextDue(spec, atDue)).getHours()).toBe(11)
    expect(new Date(nextDue(spec, atDue)).getMinutes()).toBe(0)
  })

  it('crosses midnight to the next matching hour', () => {
    const spec = parseCron('0 8 * * *')
    const from = new Date('2026-08-27T23:10:00')
    const due = new Date(nextDue(spec, from))
    expect(due.getDate()).toBe(28)
    expect(due.getHours()).toBe(8)
    expect(due.getMinutes()).toBe(0)
  })
})
