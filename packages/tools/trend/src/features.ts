/**
 * Feature extraction over the change-point history: a window of the recorded
 * series is reconstructed into a uniform grid (hold-last — the correct
 * interpolation for segmented-constant industrial signals) and summarized
 * into a small standardized feature vector: slope, level drift, variance
 * shift, spike rate, abnormal rate. Pure module — deterministic, snapshot-
 * testable, no IO.
 *
 * @module @snap-rail/trend/features
 */

import type { TrendSeriesPoint, TrendValue } from './contract.ts'
import { numericValue } from './values.ts'

/** One recorded change point (as the store holds it). */
export interface ChangePoint {
  time: number
  value: TrendValue
}

/** The five feature dimensions. Every one is scale-free after baseline
 * standardization in the engine, so mixed point kinds share one matcher. */
export interface FeatureVector {
  /** OLS slope, value per minute (sign carries direction). */
  slope: number
  /** Max standardized cumulative deviation (CUSUM shape), σ units. */
  drift: number
  /** log2 variance ratio of the later half over the earlier half. */
  variance: number
  /** Fraction of steps beyond a robust (MAD) z of 3. */
  spikes: number
  /** Fraction of recorded steps that are recorded-abnormal (`null`). */
  abnormal: number
}

/** Chinese labels per feature (the "why" shown on warnings and reports). */
export const FEATURE_LABELS: Readonly<Record<keyof FeatureVector, string>> = {
  slope: '趋势斜率',
  drift: '电平漂移',
  variance: '方差变化',
  spikes: '尖峰频率',
  abnormal: '异常占比',
}

export const FEATURE_KEYS = Object.keys(FEATURE_LABELS) as readonly (keyof FeatureVector)[]

/** Minimum recorded numeric steps for a window to be analyzable at all. */
const MIN_NUMERIC_STEPS = 4

/**
 * Reconstruct `[from, to]` into `steps` uniform samples by hold-last: each
 * grid point carries the last change at or before it; before the first
 * recorded change the value is `undefined` (never observed — distinct from a
 * recorded `null`, which is an observed abnormality). `changes` must be
 * sorted by time; the walk is a single merge pass.
 */
export function windowGrid(changes: readonly ChangePoint[], from: number, to: number, steps: number): Array<{ time: number, value: TrendValue | undefined }> {
  const grid: Array<{ time: number, value: TrendValue | undefined }> = []
  const span = Math.max(1, to - from)
  let cursor = 0
  let current: TrendValue | undefined = undefined
  // Advance past everything strictly before `from` (its value seeds the grid).
  while (cursor < changes.length && changes[cursor]!.time <= from) {
    current = changes[cursor]!.value
    cursor += 1
  }
  for (let index = 0; index < steps; index++) {
    const time = from + (span * index) / steps
    while (cursor < changes.length && changes[cursor]!.time <= time) {
      current = changes[cursor]!.value
      cursor += 1
    }
    grid.push({ time, value: current })
  }
  return grid
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdOf(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mean = meanOf(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Extract the feature vector of one window grid. Returns `null` when the
 * window carries too few numeric observations to say anything (a fresh
 * binding, a dead stretch) — callers surface that as "无法分析", never as
 * zeros that would fake a match.
 */
export function extractFeatures(grid: readonly { time: number, value: TrendValue | undefined }[], windowMs: number): FeatureVector | null {
  const recorded = grid.filter(step => step.value !== undefined)
  if (recorded.length === 0) return null
  const abnormalRate = recorded.filter(step => step.value === null).length / recorded.length

  const numeric = recorded
    .map(step => numericValue(step.value ?? null))
    .filter((value): value is number => value !== null)
  if (numeric.length < MIN_NUMERIC_STEPS) return null

  // Slope: OLS over the numeric samples, expressed per minute.
  const n = numeric.length
  const xMean = (n - 1) / 2
  const yMean = meanOf(numeric)
  let sxy = 0
  let sxx = 0
  for (let index = 0; index < n; index++) {
    sxy += (index - xMean) * (numeric[index]! - yMean)
    sxx += (index - xMean) ** 2
  }
  const perStep = sxx === 0 ? 0 : sxy / sxx
  const slope = perStep * (60_000 / Math.max(1, windowMs / n))

  // Drift: the CUSUM shape — cumulative deviation from the window mean,
  // scaled by σ·√n so windows of different lengths compare equal.
  const sigma = stdOf(numeric)
  let cumulative = 0
  let maxDeviation = 0
  for (const value of numeric) {
    cumulative += value - yMean
    maxDeviation = Math.max(maxDeviation, Math.abs(cumulative))
  }
  const drift = sigma === 0 ? 0 : maxDeviation / (sigma * Math.sqrt(n))

  // Variance shift: log2 of the later half's variance over the earlier's,
  // clamped — a log ratio explodes on quiet windows (one half σ=0) and would
  // dominate the nearest-neighbor geometry without a bound. ±4 = a 16× shift.
  const half = Math.floor(n / 2)
  const early = stdOf(numeric.slice(0, half))
  const late = stdOf(numeric.slice(half))
  const variance = early === 0 && late === 0
    ? 0
    : Math.max(-4, Math.min(4, Math.log2((late * late + 1e-12) / (early * early + 1e-12))))

  // Spikes: robust z against median/MAD; a real spike is beyond 3.
  const med = medianOf(numeric)
  const deviations = numeric.map(value => Math.abs(value - med))
  const mad = medianOf(deviations)
  const robustSigma = 1.4826 * mad
  const spikes = robustSigma === 0
    ? 0
    : numeric.filter(value => Math.abs(value - med) / robustSigma > 3).length / n

  return { slope, drift, variance, spikes, abnormal: abnormalRate }
}

/** Public projection of the stored series for reports (`trend.series.query`,
 * report payloads): decoded change points, decimated elsewhere. */
export function toSeriesPoint(time: number, value: TrendValue): TrendSeriesPoint {
  return { time, value }
}
