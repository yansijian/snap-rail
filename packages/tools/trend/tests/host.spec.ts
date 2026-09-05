import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import gatewayPlugin from '@snap-rail/gateway'
import storePlugin from '@snap-rail/store'
import fieldPlugin, { ConnectionId } from '@snap-rail/field'
import type { ConnectionRegistration } from '@snap-rail/field'
import { InProcessApiClient } from '@snap-rail/protocol'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import trendPlugin, { shouldReEmit } from '../src/host.ts'
import type { TrendAnalysisReport, TrendProfile } from '../src/contract.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
})

interface World {
  ctx: Context
  client: InProcessApiClient
  registration: ConnectionRegistration
}

const runRef = { device: 'sim', group: '布尔', name: 'run' }
const tempRef = { device: 'sim', group: '浮点', name: 'temp' }

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-trend-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(timerPlugin)
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(trendPlugin, { watchMs: 3_600_000, retentionDays: 30, cooldownMs: 900_000, corpusDays: 30 })

  let registration: ConnectionRegistration | undefined
  await ctx.plugin(Object.assign(
    function driver(sub: Context): void {
      registration = sub.connections.register(sub, { id: 'sim', driver: 'test', title: 'Sim' })
      registration.setPoints([
        { ...runRef, connection: ConnectionId('sim'), type: 'bool' as const },
        { ...tempRef, connection: ConnectionId('sim'), type: 'float' as const },
      ])
    },
    { inject: ['connections'] },
  ))
  if (registration === undefined) throw new Error('rig: registration missing')
  return {
    ctx,
    client: new InProcessApiClient(request => ctx.rpc.handleClientRequest(request)),
    registration,
  }
}

function profileOf(id: string): TrendProfile {
  return {
    id,
    name: `档案 ${id}`,
    point: tempRef,
    leadMinutes: 30,
    alertThreshold: 0.6,
    watch: true,
    bindings: [{
      topic: 'field/point-update',
      all: [{ field: 'name', op: '==', value: 'run' }, { field: 'value', op: '==', value: true }],
    }],
  }
}

describe('trend host', () => {
  it('records lossless change points through the topic mesh', async () => {
    const { client, registration } = await makeWorld()
    registration.sample(tempRef, 21.5)
    registration.sample(tempRef, 21.5) // unchanged: not a change point
    registration.sample(tempRef, 22)
    registration.sample(runRef, true)

    const series = await client.call('trend.series.query', { point: tempRef, from: 0, to: Date.now() + 1_000, maxPoints: 100 })
    expect(series.ok).toBe(true)
    if (series.ok) {
      expect(series.value.points.map(point => point.value)).toEqual([21.5, 22])
    }
  })

  it('keeps 64-bit counter values exact through the store', async () => {
    const { client, registration } = await makeWorld()
    const count = { device: 'sim', group: '计数', name: 'count' }
    registration.setPoints([
      { ...runRef, connection: ConnectionId('sim'), type: 'bool' as const },
      { ...tempRef, connection: ConnectionId('sim'), type: 'float' as const },
      { ...count, connection: ConnectionId('sim'), type: 'int' as const },
    ])
    const huge = 9_007_199_254_740_993n
    registration.sample(count, huge)

    const series = await client.call('trend.series.query', { point: count, from: 0, to: Date.now() + 1_000, maxPoints: 10 })
    expect(series.ok && series.value.points[0]?.value).toBe(huge)
  })

  it('accumulates hits from profile bindings and rejects undeclared topics', async () => {
    const { client, registration } = await makeWorld()

    const badTopic = await client.call('trend.profile.save', {
      profile: { ...profileOf('typo'), bindings: [{ topic: 'ghost/topic', all: [{ field: 'x', op: '==', value: 1 }] }] },
    })
    expect(badTopic.ok).toBe(false)
    if (!badTopic.ok) expect(badTopic.error.code).toBe('not-found')

    const saved = await client.call('trend.profile.save', { profile: profileOf('run-watch') })
    expect(saved.ok).toBe(true)

    registration.sample(runRef, false)
    registration.sample(runRef, true) // 条件命中：run == true

    const report = await client.call('trend.analysis.run', { profileId: 'run-watch' })
    expect(report.ok).toBe(true)
    if (report.ok) {
      const typed: TrendAnalysisReport = report.value.report
      expect(typed.events.length).toBe(1)
      expect(typed.events[0]?.topic).toBe('field/point-update')
      // Fresh corpus: honest degradation, not an invented number.
      expect(typed.probability?.reliable).toBe(false)
    }
  })

  it('lists, replaces, and removes profiles', async () => {
    const { client } = await makeWorld()
    await client.call('trend.profile.save', { profile: profileOf('a') })
    await client.call('trend.profile.save', { profile: { ...profileOf('b'), watch: false } })

    const listed = await client.call('trend.profile.list', {})
    expect(listed.ok && listed.value.profiles.map(profile => profile.id)).toEqual(['a', 'b'])

    const replaced = await client.call('trend.profile.save', { profile: { ...profileOf('a'), watch: false } })
    expect(replaced.ok && replaced.value.profile.watch).toBe(false)

    const removed = await client.call('trend.profile.remove', { id: 'a' })
    expect(removed).toEqual({ ok: true, value: { removed: true } })
    const after = await client.call('trend.profile.list', {})
    expect(after.ok && after.value.profiles.map(profile => profile.id)).toEqual(['b'])

    const missing = await client.call('trend.analysis.run', { profileId: 'a' })
    expect(missing.ok).toBe(false)
  })

  it('serves an ad-hoc report with the honest no-corpus caveat', async () => {
    const { client, registration } = await makeWorld()
    registration.sample(tempRef, 21.5)
    const report = await client.call('trend.analysis.run', { point: tempRef, leadMinutes: 15 })
    expect(report.ok).toBe(true)
    if (report.ok) {
      expect(report.value.report.point).toEqual(tempRef)
      expect(report.value.report.probability?.caveat).toContain('档案')
    }
  })
})

describe('warning debounce', () => {
  it('fires cold, escalates on a ≥10pp jump, and stays quiet within cooldown', () => {
    expect(shouldReEmit(undefined, 0.7, 900_000, 1_000)).toBe(true)
    const state = { emittedAt: 1_000, probability: 0.7 }
    expect(shouldReEmit(state, 0.75, 900_000, 60_000)).toBe(false)
    expect(shouldReEmit(state, 0.85, 900_000, 60_000)).toBe(true)
    expect(shouldReEmit(state, 0.75, 900_000, 1_000 + 900_000)).toBe(true)
  })
})
