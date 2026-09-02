import { describe, expect, it } from 'vitest'
import { deriveState, netMillis, pauseIntervals, theoryPerHour, theoryTotal, type ProductionEvent } from '../src/production-theory.ts'

const MODELS = [
  { id: 'SR-100', name: 'SR-100', ratePerHour: 3600 },
  { id: 'SR-200', name: 'SR-200', ratePerHour: 1800 },
]

const T0 = new Date('2026-08-27T08:00:00').getTime()
const MIN = 60_000
const HOUR = 3_600_000

describe('deriveState', () => {
  it('derives the running session and open flags from the event stream', () => {
    const events: ProductionEvent[] = [
      { action: 'production.start', actor: '1001', time: T0, detail: { model: 'SR-100' } },
      { action: 'fault.report', actor: '1001', time: T0 + 10 * MIN },
      { action: 'fault.repair-complete', actor: '1002', time: T0 + 40 * MIN },
    ]
    const state = deriveState(events, MODELS)
    expect(state.session?.model.id).toBe('SR-100')
    expect(state.session?.startedAt).toBe(T0)
    expect(state.faultActive).toBe(false)
    expect(state.downtimeActive).toBe(false)
  })

  it('clears the session on stop and ignores unknown models', () => {
    const state = deriveState([
      { action: 'production.start', actor: 'a', time: T0, detail: { model: 'NOPE' } },
      { action: 'production.stop', actor: 'a', time: T0 + MIN },
    ], MODELS)
    expect(state.session).toBeNull()
  })
})

describe('pauseIntervals', () => {
  it('unions concurrent fault and downtime pauses into one window', () => {
    const events: ProductionEvent[] = [
      { action: 'fault.report', actor: 'a', time: T0 + 10 * MIN },
      { action: 'downtime.begin', actor: 'a', time: T0 + 20 * MIN },
      { action: 'fault.repair-complete', actor: 'b', time: T0 + 50 * MIN },
      { action: 'downtime.resume', actor: 'a', time: T0 + 70 * MIN },
    ]
    const pauses = pauseIntervals(events, T0, T0 + 2 * HOUR)
    expect(pauses).toEqual([[T0 + 10 * MIN, T0 + 70 * MIN]])
  })

  it('clips to the query window and closes an open pause at the end', () => {
    const events: ProductionEvent[] = [
      { action: 'downtime.begin', actor: 'a', time: T0 },
    ]
    expect(pauseIntervals(events, T0 + 30 * MIN, T0 + HOUR)).toEqual([[T0 + 30 * MIN, T0 + HOUR]])
  })
})

describe('netMillis and theoryTotal', () => {
  it('subtracts pause overlap from wall time and scales by the model rate', () => {
    const events: ProductionEvent[] = [
      { action: 'production.start', actor: 'a', time: T0, detail: { model: 'SR-100' } },
      { action: 'downtime.begin', actor: 'a', time: T0 + 30 * MIN },
      { action: 'downtime.resume', actor: 'a', time: T0 + 60 * MIN },
    ]
    const state = deriveState(events, MODELS)
    const now = T0 + 2 * HOUR
    expect(netMillis(events, T0, now)).toBe(90 * MIN)
    // 3600/h over 1.5 net hours → 5400.
    expect(Math.round(theoryTotal(events, state, now))).toBe(5400)
  })

  it('keeps theory at zero while paused the whole window', () => {
    const events: ProductionEvent[] = [
      { action: 'production.start', actor: 'a', time: T0, detail: { model: 'SR-100' } },
      { action: 'fault.report', actor: 'a', time: T0 },
    ]
    const state = deriveState(events, MODELS)
    expect(theoryTotal(events, state, T0 + HOUR)).toBe(0)
  })
})

describe('theoryPerHour', () => {
  it('spreads theory across the 24 hour-aligned buckets ending at now', () => {
    const start = new Date('2026-08-27T09:10:00').getTime()
    const events: ProductionEvent[] = [
      { action: 'production.start', actor: 'a', time: start, detail: { model: 'SR-200' } },
    ]
    const state = deriveState(events, MODELS)
    const now = new Date('2026-08-27T10:40:00').getTime()
    const buckets = theoryPerHour(events, state, now)
    expect(buckets.length).toBe(24)
    // 09:00 bucket: 09:10–10:00 = 50 min at 1800/h → 1500.
    expect(Math.round(buckets[22] ?? 0)).toBe(1500)
    // 10:00 bucket (current): 40 min → 1200.
    expect(Math.round(buckets[23] ?? 0)).toBe(1200)
    // Buckets before the session start stay zero.
    expect(buckets.slice(0, 22).every(value => value === 0)).toBe(true)
  })
})
