/**
 * The trend host face: records every observed point as lossless change-point
 * history (its own store namespace), evaluates profile bindings against the
 * topic mesh into a per-profile hit corpus, and runs the watch loop —
 * a calibrated probability (features + k-NN + Wilson CI) at or above the
 * profile's threshold publishes the `trend/warning` topic, cooled down and
 * de-bounced, cleared by a real hit. Warnings carry their evidence; showing
 * them is the subscribers' business. Serves the trend RPC domain (profile
 * CRUD, series queries, analysis reports) that configuration and display
 * faces consume.
 *
 * @module @snap-rail/trend/host
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
import type { GatewayService, TopicService } from '@snap-rail/gateway'
import { RpcBusinessError } from '@snap-rail/protocol'
import { pointKey } from '@snap-rail/field'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import '@snap-rail/store'
import {
  TREND_WARNING_TOPIC,
  trendProfileSchema,
  trendRequestSchemas,
  trendWarningPayloadSchema,
  type TrendProfile,
  type TrendSeriesPoint,
  type TrendValue,
  type TrendWarning,
} from './contract.ts'
import { matchesBinding } from './bindings.ts'
import { analyze, type AnalysisReaders } from './analysis.ts'
import { TREND_SCHEMA, trendChanges, trendHits, trendProfiles } from './tables.ts'
import { decodeValue, encodeValue } from './values.ts'

/** Plugin config (the pool row, optional — these are the defaults). */
export interface TrendConfig {
  /** Milliseconds between watch-loop evaluations of `watch: true` profiles. */
  watchMs: number
  /** Change-point retention in days. */
  retentionDays: number
  /** A fired warning re-fires only after this cooldown or a ≥10pp jump. */
  cooldownMs: number
  /** How far back the calibration corpus reaches (≤ retention). */
  corpusDays: number
}

const trendConfigSchema = z.object({
  watchMs: z.number().int().min(5_000).default(30_000),
  retentionDays: z.number().int().min(1).max(3_650).default(30),
  cooldownMs: z.number().int().min(60_000).default(900_000),
  corpusDays: z.number().int().min(1).max(3_650).default(30),
}).strict() satisfies z.ZodType<TrendConfig>

/** Default report window when analysis.run carries no explicit one. */
const REPORT_WINDOW_MS = 6 * 3_600_000
/** Analysis series cap (points per report). */
const REPORT_MAX_POINTS = 600
/** Retention sweeps ride the watch tick, once per hour of ticking. */
const SWEEP_EVERY_TICKS = 120

/** One profile's live warning state (the debounce memory). */
interface WarningState {
  emittedAt: number
  probability: number
}

/**
 * The warning debounce decision: fire when cold, re-fire when the
 * probability jumped by ≥10 percentage points (escalation), or when the
 * cooldown has passed. Pure — snapshot-tested.
 */
export function shouldReEmit(state: WarningState | undefined, probability: number, cooldownMs: number, now: number): boolean {
  if (state === undefined) return true
  return now - state.emittedAt >= cooldownMs || probability - state.probability >= 0.10
}

/** The trend host plugin; mount after rpc, topic, store, and timer. */
const trendPlugin: Plugin.Object<TrendConfig> = {
  name: 'trend',
  inject: ['rpc', 'topic', 'store', 'timer'],
  apply(ctx: Context, config?: TrendConfig): void {
    // No cordis `Config` field: a pool row written by install + enable
    // carries no config at all, and standard-schema validation rejects
    // `undefined` — so the posture is parsed here (forge's pattern).
    const cfg = trendConfigSchema.parse(config ?? {})
    const rpc: GatewayService = ctx.rpc
    const topic: TopicService = ctx.topic
    const db = ctx.store.register(ctx, 'trend', TREND_SCHEMA)

    rpc.claimDomain(ctx, 'trend')
    ctx.topic.declare(ctx, TREND_WARNING_TOPIC, { payload: trendWarningPayloadSchema })

    // All mutable state rides this apply-scope closure (the uiSlots lesson:
    // traceable context proxies rebind `this` on every method access).
    /** Latest value per point — the change detector's memory. */
    const lastValues = new Map<string, TrendValue>()
    /** Per-profile warning debounce state. */
    const warningStates = new Map<string, WarningState>()
    /** Live binding subscriptions (one per distinct bound topic). */
    let bindingDisposers: Array<() => void> = []

    const retentionMs = cfg.retentionDays * 86_400_000
    const corpusLookbackMs = Math.min(cfg.corpusDays, cfg.retentionDays) * 86_400_000

    const readers: AnalysisReaders = {
      loadChanges(key, from, to): Array<{ time: number, value: string }> {
        return db.select({ time: trendChanges.time, value: trendChanges.value })
          .from(trendChanges)
          .where(and(eq(trendChanges.pointKey, key), gte(trendChanges.time, from), lte(trendChanges.time, to)))
          .orderBy(asc(trendChanges.time))
          .all()
      },
      loadHits(profileId, from, to): Array<{ time: number, topic: string }> {
        return db.select({ time: trendHits.time, topic: trendHits.topic })
          .from(trendHits)
          .where(and(eq(trendHits.profileId, profileId), gte(trendHits.time, from), lte(trendHits.time, to)))
          .orderBy(asc(trendHits.time))
          .all()
      },
    }

    // ---- profiles ----

    const readProfile = (row: { id: string, name: string, config: string }): TrendProfile | undefined => {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.config)
      } catch {
        ctx.logger.error('trend: profile %s has a corrupt config blob', row.id)
        return undefined
      }
      const validated = trendProfileSchema.safeParse(parsed)
      if (!validated.success) {
        ctx.logger.error('trend: profile %s failed its schema: %s', row.id, validated.error.message)
        return undefined
      }
      return validated.data
    }

    const listProfiles = (): TrendProfile[] => {
      const rows = db.select({
        id: trendProfiles.id,
        name: trendProfiles.name,
        config: trendProfiles.config,
      }).from(trendProfiles).orderBy(asc(trendProfiles.id)).all()
      return rows.map(readProfile).filter((profile): profile is TrendProfile => profile !== undefined)
    }

    const getProfile = (id: string): TrendProfile => {
      const found = listProfiles().find(profile => profile.id === id)
      if (found === undefined) {
        throw new RpcBusinessError({ code: 'not-found', details: { what: `档案 ${id} 不存在` } })
      }
      return found
    }

    /** Evaluate every profile binding against one published payload: a hit
     * lands in the corpus and retires the profile's active warning (the
     * predicted thing happened; the next episode deserves a fresh view). */
    const onPublished = (topicName: string, payload: unknown): void => {
      const now = Date.now()
      for (const profile of listProfiles()) {
        const bound = profile.bindings.some(
          binding => binding.topic === topicName && matchesBinding(binding, payload),
        )
        if (!bound) continue
        db.insert(trendHits).values({
          profileId: profile.id,
          time: now,
          topic: topicName,
          payload: JSON.stringify(payload ?? null),
        }).onConflictDoNothing().run()
        warningStates.delete(profile.id)
      }
    }

    /** Refresh the binding subscriptions after any profile change: one
     * unfiltered host subscription per distinct bound topic. */
    const refreshBindings = (): void => {
      for (const dispose of bindingDisposers) dispose()
      bindingDisposers = []
      const boundTopics = new Set<string>()
      for (const profile of listProfiles()) {
        for (const binding of profile.bindings) boundTopics.add(binding.topic)
      }
      for (const name of boundTopics) {
        bindingDisposers.push(topic.subscribe(ctx, name, undefined, payload => {
          onPublished(name, payload)
        }))
      }
    }

    // ---- the recorder: one subscription, lossless change points ----

    ctx.topic.subscribe<{ device: string, group: string, name: string, value: TrendValue, time: number }>(
      ctx,
      'field/point-update',
      undefined,
      sample => {
        const key = `${sample.device}/${sample.group}/${sample.name}`
        if (lastValues.get(key) === sample.value) return
        lastValues.set(key, sample.value)
        db.insert(trendChanges).values({
          pointKey: key,
          time: sample.time,
          value: encodeValue(sample.value),
        }).onConflictDoNothing().run()
      },
    )

    // ---- the watch loop ----

    const buildWarning = (profile: TrendProfile, evaluatedAt: number): TrendWarning | undefined => {
      const report = analyze(readers, {
        pointKey: pointKey(profile.point),
        point: profile.point,
        profileId: profile.id,
        leadMinutes: profile.leadMinutes,
        from: evaluatedAt - REPORT_WINDOW_MS,
        to: evaluatedAt,
        maxSeriesPoints: REPORT_MAX_POINTS,
        corpusLookbackMs,
      })
      const estimate = report.probability
      if (estimate === null || !estimate.reliable) return undefined
      if (estimate.probability < profile.alertThreshold) return undefined
      if (!shouldReEmit(warningStates.get(profile.id), estimate.probability, cfg.cooldownMs, evaluatedAt)) {
        return undefined
      }
      return {
        profileId: profile.id,
        profileName: profile.name,
        point: profile.point,
        emittedAt: evaluatedAt,
        leadMinutes: profile.leadMinutes,
        probability: estimate.probability,
        ciLow: estimate.ciLow,
        ciHigh: estimate.ciHigh,
        sampleCount: estimate.sampleCount,
        drivers: estimate.drivers,
        matchedEpisodes: estimate.matchedEpisodes,
        ...(estimate.caveat !== undefined ? { caveat: estimate.caveat } : {}),
      }
    }

    /** Retention sweeps ride the watch cadence (cheap, rare): drop change
     * points and hits past the retention horizon. */
    const sweepRetention = ((): (() => void) => {
      let ticks = 0
      return () => {
        ticks += 1
        if (ticks % SWEEP_EVERY_TICKS !== 1) return
        const cutoff = Date.now() - retentionMs
        db.delete(trendChanges).where(lte(trendChanges.time, cutoff)).run()
        db.delete(trendHits).where(lte(trendHits.time, cutoff)).run()
      }
    })()

    const watch = (): void => {
      sweepRetention()
      const now = Date.now()
      for (const profile of listProfiles()) {
        if (!profile.watch) continue
        let warning: TrendWarning | undefined
        try {
          warning = buildWarning(profile, now)
        } catch (cause) {
          ctx.logger.error('trend: watch evaluation failed for %s', profile.id, cause)
          continue
        }
        if (warning === undefined) continue
        warningStates.set(profile.id, { emittedAt: now, probability: warning.probability })
        ctx.topic.publish(TREND_WARNING_TOPIC, warning)
      }
    }

    ctx.interval(watch, cfg.watchMs)

    // ---- the trend RPC domain ----

    rpc.method(ctx, 'trend.profile.list', { request: trendRequestSchemas['trend.profile.list'] }, () => ({
      profiles: listProfiles(),
    }))

    rpc.method(ctx, 'trend.profile.save', { request: trendRequestSchemas['trend.profile.save'] }, ({ profile }) => {
      // A binding on an undeclared topic can never hit — reject the typo now.
      const declared = new Set(topic.list().map(entry => entry.name))
      for (const binding of profile.bindings) {
        if (!declared.has(binding.topic)) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `未声明的话题：${binding.topic}` } })
        }
      }
      db.insert(trendProfiles).values({
        id: profile.id,
        name: profile.name,
        config: JSON.stringify(profile),
        updatedAt: Date.now(),
      }).onConflictDoUpdate({
        target: trendProfiles.id,
        set: { name: profile.name, config: JSON.stringify(profile), updatedAt: Date.now() },
      }).run()
      warningStates.delete(profile.id)
      refreshBindings()
      return { profile }
    })

    rpc.method(ctx, 'trend.profile.remove', { request: trendRequestSchemas['trend.profile.remove'] }, ({ id }) => {
      db.delete(trendProfiles).where(eq(trendProfiles.id, id)).run()
      warningStates.delete(id)
      refreshBindings()
      return { removed: true } as const
    })

    rpc.method(ctx, 'trend.series.query', { request: trendRequestSchemas['trend.series.query'] }, request => {
      const rows = readers.loadChanges(pointKey(request.point), request.from, request.to)
      const decoded: TrendSeriesPoint[] = rows.map(row => {
        try {
          return { time: row.time, value: decodeValue(row.value) }
        } catch {
          // A corrupt value must not take the whole series down.
          return { time: row.time, value: null }
        }
      })
      return { points: decimate(decoded, request.maxPoints) }
    })

    rpc.method(ctx, 'trend.analysis.run', { request: trendRequestSchemas['trend.analysis.run'] }, request => {
      const evaluatedAt = request.to ?? Date.now()
      if (request.profileId !== undefined) {
        const profile = getProfile(request.profileId)
        return {
          report: analyze(readers, {
            pointKey: pointKey(profile.point),
            point: profile.point,
            profileId: profile.id,
            leadMinutes: profile.leadMinutes,
            from: request.from ?? evaluatedAt - REPORT_WINDOW_MS,
            to: evaluatedAt,
            maxSeriesPoints: REPORT_MAX_POINTS,
            corpusLookbackMs,
          }),
        }
      }
      if (request.point === undefined) {
        throw new RpcBusinessError({ code: 'bad-request', details: { issues: ['需要 profileId 或 point'] } })
      }
      const leadMinutes = request.leadMinutes ?? 30
      return {
        report: analyze(readers, {
          pointKey: pointKey(request.point),
          point: request.point,
          leadMinutes,
          from: request.from ?? evaluatedAt - REPORT_WINDOW_MS,
          to: evaluatedAt,
          maxSeriesPoints: REPORT_MAX_POINTS,
          corpusLookbackMs,
        }),
      }
    })

    // Boot: subscribe to whatever the stored profiles already bind.
    refreshBindings()
  },
}

/** Uniform decimation to at most `max` samples, first and last kept. */
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

export default trendPlugin
