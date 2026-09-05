/**
 * The probability engine: small-sample, explainable, deterministic. A
 * profile's history is summarized into corpus windows (feature vector +
 * whether a bound event actually followed within the lead horizon). The
 * window under evaluation is compared against that corpus by standardized
 * distance; windows shaped like it form the reference set, and the empirical
 * rate at which such windows were followed by an event — Laplace-smoothed,
 * Wilson-bounded — is the probability. Pure module: same data, same number.
 *
 * Deliberately not a neural network: industrial terminals accumulate tens to
 * hundreds of events, where a calibrated non-parametric estimate with an
 * honest confidence interval beats any black box. Once n grows large the
 * same feature vector can feed a logistic model behind this same interface.
 *
 * @module @snap-rail/trend/engine
 */

import type { TrendDriver, TrendEpisode, TrendProbability } from './contract.ts'
import { FEATURE_KEYS, FEATURE_LABELS, type FeatureVector } from './features.ts'

/** Corpus windows must reach this many matched references before the
 * estimate claims to be reliable. */
export const MIN_RELIABLE_N = 5

/** Upper bound on the reference neighborhood (the k in k-NN). */
const MAX_REFERENCE_WINDOWS = 20

/** One corpus window: the features of a historical lead window and whether
 * a bound event fired within the horizon after it. */
export interface CorpusWindow {
  from: number
  to: number
  features: FeatureVector
  followedByEvent: boolean
}

/** Wilson score interval — the honest bracket for a small-sample rate. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): { low: number, high: number } {
  if (trials === 0) return { low: 0, high: 0 }
  const p = successes / trials
  const denominator = 1 + z * z / trials
  const center = (p + z * z / (2 * trials)) / denominator
  const spread = (z / denominator) * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) }
}

interface DimensionStats {
  center: number
  scale: number
}

/** Per-dimension standardization: median centering, population-σ scaling.
 * σ (not MAD) because trend corpora are multimodal — half flat history and
 * half event-preceding shapes — and a MAD collapses onto the majority mode,
 * blowing the minority's distances up; a constant dimension falls back to a
 * no-op scale instead of dividing by zero. */
function dimensionStats(values: readonly number[]): DimensionStats {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const center = sorted.length % 2 === 1
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  const variance = values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length
  const scale = Math.sqrt(variance)
  return { center, scale: scale > 1e-9 ? scale : 1 }
}

function standardize(value: number, stats: DimensionStats): number {
  return (value - stats.center) / stats.scale
}

/**
 * Calibrate the probability that a bound event fires within the lead
 * horizon, given the evaluated window's features and the profile's corpus.
 * Returns `null` when the corpus cannot support any estimate (no analyzable
 * history); thin corpora return an estimate with `reliable: false` and a
 * caveat — the number is shown, its distrust is spelled out.
 */
export function calibrateProbability(
  current: FeatureVector,
  corpus: readonly CorpusWindow[],
  options: { emptyCorpusCaveat?: string } = {},
): TrendProbability | null {
  if (corpus.length === 0) {
    return {
      probability: 0,
      ciLow: 0,
      ciHigh: 0,
      sampleCount: 0,
      reliable: false,
      drivers: [],
      matchedEpisodes: [],
      caveat: options.emptyCorpusCaveat ?? '历史语料为空，无法估计',
    }
  }

  const stats = FEATURE_KEYS.map(key => dimensionStats(corpus.map(window => window.features[key])))
  const query = FEATURE_KEYS.map((key, index) => standardize(current[key], stats[index]!))

  const eventWindows = corpus.filter(window => window.followedByEvent)
  if (eventWindows.length === 0) {
    return {
      probability: 0,
      ciLow: 0,
      ciHigh: 0,
      sampleCount: 0,
      reliable: false,
      drivers: [],
      matchedEpisodes: [],
      caveat: '语料中尚无该档案的命中事件，概率无法校准',
    }
  }

  // Every historical window's standardized distance to the evaluated one.
  const scored = corpus.map(window => {
    const vector = FEATURE_KEYS.map((key, index) => standardize(window.features[key], stats[index]!))
    let sum = 0
    for (let index = 0; index < query.length; index++) {
      sum += (query[index]! - vector[index]!) ** 2
    }
    return { window, distance: Math.sqrt(sum / query.length) }
  }).sort((a, b) => a.distance - b.distance)

  // The reference set: the k nearest windows, with k sized by the baseline
  // population — "a typical baseline-sized neighborhood of now". An
  // event-shaped window pulls the events in; a quiet one stays among quiet
  // history; the estimate is exactly the neighborhood's hit rate.
  const baselineCount = corpus.length - eventWindows.length
  const k = Math.max(1, Math.min(baselineCount, MAX_REFERENCE_WINDOWS, corpus.length))
  const matched = scored.slice(0, k)
  const successes = matched.filter(entry => entry.window.followedByEvent).length
  const trials = matched.length
  if (trials === 0) {
    return {
      probability: 0,
      ciLow: 0,
      ciHigh: 0,
      sampleCount: 0,
      reliable: false,
      drivers: [],
      matchedEpisodes: [],
      caveat: '历史语料中没有与当前形态相近的窗口，概率无法校准',
    }
  }
  const smoothed = (successes + 1) / (trials + 2)
  const bounds = wilsonInterval(successes, trials)

  // The evaluated window's own standardized deviations, strongest first —
  // the evidence a subscriber shows the operator.
  const drivers: TrendDriver[] = FEATURE_KEYS
    .map((key, index) => ({
      feature: key,
      label: FEATURE_LABELS[key],
      deviation: query[index] ?? 0,
    }))
    .sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
    .slice(0, 3)

  const matchedEpisodes: TrendEpisode[] = [...matched]
    .slice(0, 5)
    .map(entry => ({
      from: entry.window.from,
      to: entry.window.to,
      similarity: 1 / (1 + entry.distance),
      followedByEvent: entry.window.followedByEvent,
    }))

  const reliable = trials >= MIN_RELIABLE_N
  return {
    probability: smoothed,
    ciLow: bounds.low,
    ciHigh: bounds.high,
    sampleCount: trials,
    reliable,
    drivers,
    matchedEpisodes,
    ...(reliable ? {} : { caveat: `样本不足（参考窗 ${trials} 个），估计仅供参考` }),
  }
}
