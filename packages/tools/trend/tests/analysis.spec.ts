import { describe, expect, it } from 'vitest'
import { analyze, type AnalysisReaders } from '../src/analysis.ts'
import { encodeValue } from '../src/values.ts'
import type { ChangePoint } from '../src/features.ts'

const MINUTE = 60_000
const HOUR = 3_600_000
const LEAD = 10 // minutes
const HORIZON = LEAD * MINUTE
/** The moment of the last hit: the trailing window is exactly the ramp. */
const EVALUATED_AT = 200 * MINUTE

/** Sawtooth corpus: ramps up over the whole lead before each hit, resets at
 * the hit, flat 10 in between. Ramps are the event-preceding shape. */
function sawtoothChanges(hits: readonly number[]): ChangePoint[] {
  const changes: ChangePoint[] = [{ time: 0, value: 10 }]
  for (const hit of hits) {
    for (let time = hit - HORIZON + MINUTE; time < hit; time += MINUTE) {
      changes.push({ time, value: 10 + (10 * (time - (hit - HORIZON))) / HORIZON })
    }
    changes.push({ time: hit, value: 10 })
  }
  return changes
}

function readersWith(changes: ChangePoint[], hits: number[]): AnalysisReaders {
  return {
    loadChanges: (_key, from, to) => changes.filter(change => change.time >= from && change.time <= to)
      .map(change => ({ time: change.time, value: encodeValue(change.value) })),
    loadHits: (_profileId, from, to) => hits.filter(time => time >= from && time <= to)
      .map(time => ({ time, topic: 'field/point-update' })),
  }
}

const HITS = [50 * MINUTE, 80 * MINUTE, 110 * MINUTE, 140 * MINUTE, 170 * MINUTE, 200 * MINUTE]

function request(maxSeriesPoints = 600) {
  return {
    pointKey: 'd/g/x',
    point: { device: 'd', group: 'g', name: 'x' },
    profileId: 'p1',
    leadMinutes: LEAD,
    from: EVALUATED_AT - 6 * HOUR,
    to: EVALUATED_AT,
    maxSeriesPoints,
    corpusLookbackMs: 4 * HOUR,
  }
}

describe('analysis shaping', () => {
  it('ranks a ramping now-window as event-like when history agrees', () => {
    const report = analyze(readersWith(sawtoothChanges(HITS), HITS), request())
    const probability = report.probability
    expect(probability).not.toBeNull()
    expect(probability!.reliable).toBe(true)
    expect(probability!.probability).toBeGreaterThan(0.5)
    expect(probability!.drivers[0]?.feature).toBe('slope')
    expect(probability!.matchedEpisodes.length).toBeGreaterThan(0)
  })

  it('is deterministic for the same corpus', () => {
    const readers = readersWith(sawtoothChanges(HITS), HITS)
    expect(analyze(readers, request())).toEqual(analyze(readers, request()))
  })

  it('marks the hits inside the report window as events', () => {
    const report = analyze(readersWith(sawtoothChanges(HITS), HITS), request())
    expect(report.events.map(event => event.time)).toEqual(HITS.filter(time => time <= EVALUATED_AT))
    expect(report.events.every(event => event.topic === 'field/point-update')).toBe(true)
  })

  it('decimates the series to the requested ceiling', () => {
    const readers = readersWith(sawtoothChanges(HITS), HITS)
    const full = analyze(readers, request(10_000))
    const capped = analyze(readers, request(50))
    expect(full.series.length).toBeGreaterThan(50)
    expect(capped.series.length).toBeLessThanOrEqual(51)
    expect(capped.series[0]?.time).toBe(full.series[0]?.time)
  })

  it('declines to estimate for an ad-hoc analysis (no corpus without a profile)', () => {
    const report = analyze(readersWith(sawtoothChanges(HITS), HITS), { ...request(), profileId: undefined })
    expect(report.probability!.reliable).toBe(false)
    expect(report.probability!.caveat).toContain('档案')
  })

  it('reports an empty corpus as unreliable instead of inventing a number', () => {
    const report = analyze(readersWith([], []), request())
    expect(report.series).toEqual([])
    expect(report.events).toEqual([])
    expect(report.probability!.sampleCount).toBe(0)
    expect(report.probability!.reliable).toBe(false)
  })
})
