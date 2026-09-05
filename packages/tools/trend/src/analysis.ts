/**
 * The analysis orchestrator: pulls a point's recorded change points and a
 * profile's hit history through injected readers, shapes the report window
 * into series + event marks, builds the engine's corpus over the lookback
 * horizon, and calibrates the trailing lead window's probability. All IO
 * lives behind {@link AnalysisReaders} — the shaping itself is deterministic
 * and testable without cordis.
 *
 * @module @snap-rail/trend/analysis
 */

import type { TrendAnalysisReport, TrendProbability, TrendSeriesPoint } from './contract.ts'
import { calibrateProbability, type CorpusWindow } from './engine.ts'
import { decodeValue } from './values.ts'
import { extractFeatures, windowGrid, type ChangePoint } from './features.ts'

/** Store access the analyzer needs; the host wires these to drizzle, tests
 * to arrays. */
export interface AnalysisReaders {
  /** Recorded change points of one point key in `[from, to]`, time-ordered. */
  loadChanges(pointKey: string, from: number, to: number): Array<{ time: number, value: string }>
  /** One profile's hit marks in `[from, to]`, time-ordered. */
  loadHits(profileId: string, from: number, to: number): Array<{ time: number, topic: string }>
}

export interface AnalyzeRequest {
  pointKey: string
  /** The report's subject point (echoed into the report). */
  point: { device: string, group: string, name: string }
  profileId?: string | undefined
  leadMinutes: number
  /** The report window (series + event marks). */
  from: number
  to: number
  /** Series decimation ceiling (display math, client-side). */
  maxSeriesPoints: number
  /** How far back the calibration corpus reaches (bounded by retention). */
  corpusLookbackMs: number
}

/** Grid resolution per analyzed window (shape fidelity vs. cost). */
const GRID_STEPS = 24
/** Upper bound on sampled corpus windows; the step widens before this bites. */
const MAX_CORPUS_WINDOWS = 1500

/** Binary-search slice of the sorted change array covering `[from, to]`
 * plus the one preceding change (its value seeds the window's start). */
function sliceForWindow(changes: readonly ChangePoint[], from: number, to: number): ChangePoint[] {
  let lo = 0
  let hi = changes.length
  while (lo < hi) {
    const middle = (lo + hi) >> 1
    if (changes[middle]!.time <= from) lo = middle + 1
    else hi = middle
  }
  const start = Math.max(0, lo - 1)
  let end = lo
  while (end < changes.length && changes[end]!.time <= to) end += 1
  return changes.slice(start, end)
}

function decimate(points: TrendSeriesPoint[], max: number): TrendSeriesPoint[] {
  if (points.length <= max) return points
  const stride = points.length / max
  const picked: TrendSeriesPoint[] = []
  for (let index = 0; index < max; index++) {
    picked.push(points[Math.min(points.length - 1, Math.floor(index * stride))]!)
  }
  const last = points[points.length - 1]
  if (last !== undefined && picked[picked.length - 1] !== last) picked.push(last)
  return picked
}

/** Shape one analysis: report window + calibrated probability of the
 * trailing lead window. */
export function analyze(readers: AnalysisReaders, request: AnalyzeRequest): TrendAnalysisReport {
  const { pointKey, profileId, leadMinutes, from, to } = request

  const windowChanges = readers.loadChanges(pointKey, from, to)
    .map(row => ({ time: row.time, value: decodeValue(row.value) }))
  const series: TrendSeriesPoint[] = windowChanges.map(change => ({ time: change.time, value: change.value }))

  const events = profileId === undefined
    ? []
    : readers.loadHits(profileId, from, to).map(hit => ({ time: hit.time, topic: hit.topic }))

  let probability: TrendProbability | null = null
  if (profileId !== undefined) {
    probability = estimate(readers, {
      profileId,
      pointKey,
      leadMinutes,
      evaluatedAt: to,
      corpusLookbackMs: request.corpusLookbackMs,
    })
  } else {
    probability = {
      probability: 0,
      ciLow: 0,
      ciHigh: 0,
      sampleCount: 0,
      reliable: false,
      drivers: [],
      matchedEpisodes: [],
      caveat: '临时分析没有绑定事件语料（概率估计需要档案）；序列与事件标注仅供参考',
    }
  }

  return {
    point: request.point,
    window: { from, to },
    leadMinutes,
    series: decimate(series, request.maxSeriesPoints),
    events,
    probability,
  }
}

interface EstimateRequest {
  profileId: string
  pointKey: string
  leadMinutes: number
  /** The moment the prediction speaks about ("now", usually). */
  evaluatedAt: number
  corpusLookbackMs: number
}

/** Calibrate the trailing lead window against the profile's corpus. */
function estimate(readers: AnalysisReaders, request: EstimateRequest): TrendProbability | null {
  const { profileId, pointKey, leadMinutes, evaluatedAt, corpusLookbackMs } = request
  const horizonMs = leadMinutes * 60_000
  const corpusFrom = evaluatedAt - corpusLookbackMs

  const allChanges = readers.loadChanges(pointKey, corpusFrom, evaluatedAt)
    .map(row => ({ time: row.time, value: decodeValue(row.value) }))
  const currentGrid = windowGrid(allChanges, evaluatedAt - horizonMs, evaluatedAt, GRID_STEPS)
  const current = extractFeatures(currentGrid, horizonMs)
  if (current === null) {
    return {
      probability: 0,
      ciLow: 0,
      ciHigh: 0,
      sampleCount: 0,
      reliable: false,
      drivers: [],
      matchedEpisodes: [],
      caveat: '观察点在评估窗内没有足够的数值记录，无法分析',
    }
  }

  const hits = readers.loadHits(profileId, corpusFrom, evaluatedAt).map(hit => hit.time)

  // Sample corpus windows of one lead length, ascending; label each by
  // whether a hit fired within the horizon after its end. Windows whose
  // horizon reaches past `evaluatedAt` are unlabeled future — excluded.
  const span = evaluatedAt - horizonMs - corpusFrom
  const step = Math.max(horizonMs / 2, Math.ceil(span / MAX_CORPUS_WINDOWS))
  const corpus: CorpusWindow[] = []
  for (let end = corpusFrom + horizonMs; end + horizonMs <= evaluatedAt; end += step) {
    const grid = windowGrid(sliceForWindow(allChanges, end - horizonMs, end), end - horizonMs, end, GRID_STEPS)
    const features = extractFeatures(grid, horizonMs)
    if (features === null) continue
    const followedByEvent = hits.some(hit => hit >= end && hit <= end + horizonMs)
    corpus.push({ from: end - horizonMs, to: end, features, followedByEvent })
  }

  return calibrateProbability(current, corpus)
}
