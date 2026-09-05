import { describe, expect, it } from 'vitest'
import { calibrateProbability, wilsonInterval, type CorpusWindow } from '../src/engine.ts'
import type { FeatureVector } from '../src/features.ts'

function vector(slope: number): FeatureVector {
  return { slope, drift: 0, variance: 0, spikes: 0, abnormal: 0 }
}

function corpus(events: readonly number[], baselines: readonly number[]): CorpusWindow[] {
  return [
    ...events.map(slope => ({ from: 0, to: 1, features: vector(slope), followedByEvent: true })),
    ...baselines.map(slope => ({ from: 2, to: 3, features: vector(slope), followedByEvent: false })),
  ]
}

describe('wilson interval', () => {
  it('brackets the point rate and degenerates on zero trials', () => {
    const { low, high } = wilsonInterval(5, 10)
    expect(low).toBeGreaterThan(0)
    expect(high).toBeLessThan(1)
    expect(low).toBeLessThan(0.5)
    expect(high).toBeGreaterThan(0.5)
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 })
    expect(wilsonInterval(0, 8).low).toBe(0)
    expect(wilsonInterval(8, 8).high).toBe(1)
  })
})

describe('probability calibration', () => {
  it('scores an event-shaped window high when history agrees', () => {
    // Events consistently follow steep rises; the window now looks steep.
    const result = calibrateProbability(vector(5), corpus(
      [5, 5.2, 4.8, 5.1, 4.9, 5.3],
      [0, 0.1, -0.1, 0.2, 0, -0.2, 0.1, 0, 0.2, -0.1],
    ))
    expect(result).not.toBeNull()
    expect(result!.reliable).toBe(true)
    expect(result!.probability).toBeGreaterThan(0.5)
    expect(result!.probability).toBeLessThanOrEqual(1)
    expect(result!.ciLow).toBeLessThanOrEqual(result!.probability)
    expect(result!.ciHigh).toBeGreaterThanOrEqual(result!.probability)
    expect(result!.drivers[0]?.feature).toBe('slope')
    expect(result!.caveat).toBeUndefined()
  })

  it('scores a baseline-shaped window low', () => {
    const result = calibrateProbability(vector(0), corpus(
      [5, 5.1, 4.9, 5, 5.2, 4.8],
      [0, 0.1, -0.1, 0, 0.2, -0.2, 0.1, 0, -0.1, 0],
    ))
    expect(result).not.toBeNull()
    expect(result!.probability).toBeLessThan(0.45)
  })

  it('degrades honestly on a thin or empty corpus', () => {
    const empty = calibrateProbability(vector(1), [])
    expect(empty!.probability).toBe(0)
    expect(empty!.reliable).toBe(false)
    expect(empty!.caveat).toBeTruthy()

    const noEvents = calibrateProbability(vector(1), corpus([], [0, 0.1, 0.2, 0.3, 0.4, 0.5]))
    expect(noEvents!.probability).toBe(0)
    expect(noEvents!.reliable).toBe(false)
    expect(noEvents!.caveat).toContain('尚无')

    // A reference neighborhood of two cannot claim reliability.
    const thin = calibrateProbability(vector(5), corpus([5, 5.1], [0, 0.1, 0.2]))
    expect(thin!.reliable).toBe(false)
    expect(thin!.caveat).toContain('样本不足')
  })

  it('is deterministic: same corpus, same estimate', () => {
    const sample = corpus([5, 5.1, 4.9, 5, 5.2], [0, 0.1, -0.1, 0, 0.2])
    const first = calibrateProbability(vector(5), sample)
    const second = calibrateProbability(vector(5), sample)
    expect(first).toEqual(second)
  })
})
