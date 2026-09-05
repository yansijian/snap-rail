/**
 * The trend domain's wire contract: observation profiles, the warning topic
 * payload, series queries, and analysis reports. This module is the merge
 * point — programs importing it (the host face, the settings page, tests)
 * see the rows in the protocol's open maps; everyone else stays untyped.
 * Pure face: zod + types only, no node imports, so the client bundle may
 * inline it.
 *
 * @module @snap-rail/trend/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'
import { pointRefSchema, type PointRef } from '@snap-rail/field/contract'

/** The warning topic: the plugin's output face. Subscribers (dashboards,
 * titlbebars, agents) render warnings however they please. */
export const TREND_WARNING_TOPIC = 'trend/warning'

/** One sample value as trend analysis sees it (the field value vocabulary). */
export type TrendValue = boolean | bigint | number | string | null

/** Comparison operators a binding condition supports; ordering ops are only
 * meaningful on numeric fields (the settings page offers them by field type). */
export const trendOpSchema = z.enum(['==', '!=', '>', '<', '>=', '<='])

/** One condition row: payload field, comparison, literal to compare against.
 * The literal is JSON-safe by design (profiles are stored as JSON blobs);
 * int64 payloads compare numerically against a number literal. */
export const trendConditionSchema = z.object({
  field: z.string().min(1).max(128),
  op: trendOpSchema,
  value: z.union([z.boolean(), z.number(), z.string()]),
}).strict()

/** One binding: a declared topic plus the AND-combined payload conditions
 * that make a hit. "点 X 为 ON" = topic `field/point-update` with
 * `name == X` and `value == true`. */
export const trendBindingSchema = z.object({
  topic: z.string().min(1).max(128),
  all: z.array(trendConditionSchema).min(1).max(8),
}).strict()

/** The validated binding. */
export type TrendBinding = z.output<typeof trendBindingSchema>

/** An observation profile: the watched point (feature source), the bound
 * topics (event corpus), and the warning posture. */
export const trendProfileSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab'),
  name: z.string().min(1).max(128),
  point: pointRefSchema,
  /** Lead time L: warnings promise "within the next L minutes" (1–240). */
  leadMinutes: z.number().int().min(1).max(240),
  /** The watch loop publishes a warning at or above this probability. */
  alertThreshold: z.number().min(0.05).max(0.95),
  /** Background evaluation on the watch cadence. */
  watch: z.boolean(),
  bindings: z.array(trendBindingSchema).min(1).max(8),
}).strict()

/** The validated profile. */
export type TrendProfile = z.output<typeof trendProfileSchema>

/** One standardized feature contribution (the "why" of a warning). */
export interface TrendDriver {
  /** Feature key (`slope`, `cusum`, `variance`, `spikes`, `abnormal`). */
  feature: string
  /** Human-readable label (中文). */
  label: string
  /** Standardized deviation from the no-event baseline (sign matters). */
  deviation: number
}

/** One historical window whose shape matched the evaluated one. */
export interface TrendEpisode {
  from: number
  to: number
  /** Similarity in [0, 1] against the evaluated window. */
  similarity: number
  /** Whether an event actually followed this episode (the evidence base). */
  followedByEvent: boolean
}

/** The calibrated probability estimate with its evidence. `reliable` is
 * false while the corpus is thin (n < 5) — the numbers are shown, the
 * caveat says why to distrust them. */
export interface TrendProbability {
  probability: number
  ciLow: number
  ciHigh: number
  /** Sample size behind the estimate (matched historical windows). */
  sampleCount: number
  reliable: boolean
  drivers: TrendDriver[]
  matchedEpisodes: TrendEpisode[]
  caveat?: string
}

/** One reconstructed series point (hold-last interpolation of the change
 * points; `null` marks an abnormal stretch). */
export interface TrendSeriesPoint {
  time: number
  value: TrendValue
}

/** One bound-topic hit inside an analysis window. */
export interface TrendEventMark {
  time: number
  topic: string
}

/** The full analysis report `trend.analysis.run` serves. */
export interface TrendAnalysisReport {
  point: PointRef
  window: { from: number, to: number }
  leadMinutes: number
  /** The hold-last reconstruction the features were computed on. */
  series: TrendSeriesPoint[]
  events: TrendEventMark[]
  /** `null` while the corpus cannot support an estimate at all. */
  probability: TrendProbability | null
}

/** The warning topic's payload (also the `detail` of any durable record a
 * subscriber chooses to keep). */
export const trendWarningPayloadSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  point: pointRefSchema,
  emittedAt: z.number(),
  leadMinutes: z.number().int(),
  probability: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  sampleCount: z.number().int(),
  drivers: z.array(z.object({
    feature: z.string(),
    label: z.string(),
    deviation: z.number(),
  }).strict()),
  matchedEpisodes: z.array(z.object({
    from: z.number(),
    to: z.number(),
    similarity: z.number(),
    followedByEvent: z.boolean(),
  }).strict()),
  caveat: z.string().optional(),
}).strict()

/** The validated warning payload. */
export type TrendWarning = z.output<typeof trendWarningPayloadSchema>

/** The trend domain's methods. */
export interface TrendApi {
  /** Every stored profile, name-ordered. */
  profileList(payload: {}): Promise<RpcResponse<{ profiles: TrendProfile[] }>>
  /** Create or replace a profile by id. */
  profileSave(payload: { profile: TrendProfile }): Promise<RpcResponse<{ profile: TrendProfile }>>
  /** Drop a profile (its recorded hit history stays until retention cleans it). */
  profileRemove(payload: { id: string }): Promise<RpcResponse<{ removed: true }>>
  /** The recorded change-point series of one point in a time window,
   * downsampled to at most `maxPoints` samples (client-side display math). */
  seriesQuery(payload: { point: PointRef, from: number, to: number, maxPoints: number }): Promise<RpcResponse<{ points: TrendSeriesPoint[] }>>
  /** Run the analysis: profile-driven (profileId) or ad-hoc (point +
   * leadMinutes); the window defaults to the trailing lookback. */
  analysisRun(payload: { profileId?: string, point?: PointRef, leadMinutes?: number, from?: number, to?: number }): Promise<RpcResponse<{ report: TrendAnalysisReport }>>
}

// --- request schemas (ride with host registration) ---

const emptyRequest = z.object({}).strict()

/** Request schemas for the trend domain methods. */
export const trendRequestSchemas = {
  'trend.profile.list': emptyRequest,
  'trend.profile.save': z.object({ profile: trendProfileSchema }).strict(),
  'trend.profile.remove': z.object({ id: z.string().min(1) }).strict(),
  'trend.series.query': z.object({
    point: pointRefSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    maxPoints: z.number().int().min(10).max(2000),
  }).strict(),
  'trend.analysis.run': z.object({
    profileId: z.string().min(1).optional(),
    point: pointRefSchema.optional(),
    leadMinutes: z.number().int().min(1).max(240).optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
  }).strict(),
} as const

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'trend.profile.list': TrendApi['profileList']
    'trend.profile.save': TrendApi['profileSave']
    'trend.profile.remove': TrendApi['profileRemove']
    'trend.series.query': TrendApi['seriesQuery']
    'trend.analysis.run': TrendApi['analysisRun']
  }

  interface FrameMap {
    /** One early warning: the calibrated probability that the profile's
     * bound events fire within its lead window. */
    'trend/warning': TrendWarning
  }
}
