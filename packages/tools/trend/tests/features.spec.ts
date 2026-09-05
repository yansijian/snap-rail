import { describe, expect, it } from 'vitest'
import { extractFeatures, windowGrid, type ChangePoint } from '../src/features.ts'

describe('window grid (hold-last reconstruction)', () => {
  it('carries the last change at or before each grid point', () => {
    const changes: ChangePoint[] = [
      { time: 10, value: 5 },
      { time: 20, value: 7 },
    ]
    const grid = windowGrid(changes, 0, 30, 4)
    expect(grid.map(step => step.time)).toEqual([0, 7.5, 15, 22.5])
    // Before the first change the value was never observed — distinct from null.
    expect(grid.map(step => step.value)).toEqual([undefined, undefined, 5, 7])
  })

  it('seeds from the change preceding the window', () => {
    const changes: ChangePoint[] = [{ time: 0, value: 3 }, { time: 100, value: 9 }]
    const grid = windowGrid(changes, 50, 200, 2)
    expect(grid.map(step => step.value)).toEqual([3, 9])
  })
})

function gridValues(values: Array<number | null>): Array<{ time: number, value: number | null }> {
  return values.map((value, index) => ({ time: index * 1000, value }))
}

describe('feature extraction', () => {
  it('reads a rising window as positive slope and skips unobserved steps', () => {
    const features = extractFeatures(gridValues([1, 2, 3, 4, 5, 6]), 5_000)
    expect(features).not.toBeNull()
    expect(features!.slope).toBeGreaterThan(0)
    expect(features!.spikes).toBe(0)
    expect(features!.abnormal).toBe(0)
  })

  it('reads a flat window as no slope and no drift', () => {
    const features = extractFeatures(gridValues([5, 5, 5, 5, 5, 5]), 5_000)
    expect(features).not.toBeNull()
    expect(features!.slope).toBeCloseTo(0, 9)
    expect(features!.drift).toBe(0)
    expect(features!.variance).toBe(0)
  })

  it('counts a far outlier as a spike', () => {
    // The outlier must stay a minority or the MAD itself collapses onto it.
    const features = extractFeatures(gridValues([1, 1.1, 0.9, 1, 10, 1.1, 0.9, 1]), 7_000)
    expect(features).not.toBeNull()
    expect(features!.spikes).toBeGreaterThan(0)
  })

  it('rates recorded nulls as abnormal share', () => {
    const features = extractFeatures(gridValues([1, 2, null, 4, 5, 6]), 5_000)
    expect(features).not.toBeNull()
    expect(features!.abnormal).toBeCloseTo(1 / 6, 9)
  })

  it('refuses a window without enough numeric observations', () => {
    expect(extractFeatures([{ time: 0, value: undefined }, { time: 1, value: undefined }], 1_000)).toBeNull()
    expect(extractFeatures(gridValues([null, null, null, 1]), 3_000)).toBeNull()
  })
})
