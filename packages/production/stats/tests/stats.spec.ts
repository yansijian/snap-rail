import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '@snap-rail/store'
import { ConnectionId, type PointRef } from '@snap-rail/field'
import fieldPlugin, { type ConnectionRegistration } from '@snap-rail/field'
import timerPlugin from '../../../../vendor/timer/src/index.ts'
import productionStatsPlugin, { shiftKeyOf, shiftOf } from '../src/index.ts'
import { productionStatsSnapshotSchema, type ProductionStatsSnapshot } from '../src/contract.ts'
import { afterEach, describe, expect, it } from 'vitest'

/** Settings key holding the signed-on operator (same source as station-rpc). */
const OPERATOR_KEY = 'session.operatorId'

const COUNT: PointRef = { device: 'plc1', group: '产量', name: '产量计数' }
const ALT: PointRef = { device: 'plc1', group: '产量', name: '成品计数' }

interface World {
  ctx: Context
  home: string
  /** Push a sample (or an abnormal `null`) on the rig connection. */
  drive(ref: PointRef, value: number | null): void
  login(operator: string): void
  logout(): void
  /** Every validated `production/stats-changed` frame, oldest first. */
  snapshots: ProductionStatsSnapshot[]
}

const worlds: World[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose().catch(() => {})
    rmSync(world.home, { recursive: true, force: true })
  }
})

/** Mount the stats world over a temp home (or a reused one for the
 * restart test: the store and settings.json persist there). */
async function makeWorld(existingHome?: string): Promise<World> {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'snap-rail-production-stats-'))
  const ctx = new Context()
  ctx.provide('snapRailHome', home)
  await ctx.plugin(gatewayPlugin, { name: 'stats-test', version: '0.1.0', bin: 'test' })
  await ctx.plugin(settingsPlugin)
  await ctx.plugin(storePlugin)
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(timerPlugin)

  let rig: ConnectionRegistration | undefined
  await ctx.plugin(Object.assign(
    function rigDriver(sub: Context): void {
      rig = sub.connections.register(sub, { id: ConnectionId('rig'), driver: 'rig', title: 'Rig' })
      rig.setPoints([COUNT, ALT].map(ref => ({ ...ref, connection: ConnectionId('rig'), type: 'int' })))
    },
    { inject: ['connections'] },
  ))

  await ctx.plugin(productionStatsPlugin, { flushMs: 20 })

  const snapshots: ProductionStatsSnapshot[] = []
  ctx.rpc.attachDownlink(frame => {
    if (frame.method !== 'production/stats-changed') return
    const parsed = productionStatsSnapshotSchema.safeParse(frame.payload)
    if (parsed.success) snapshots.push(parsed.data)
  })

  const world: World = {
    ctx,
    home,
    drive: (ref, value) => { rig?.sample(ref, value === null ? null : BigInt(value)) },
    login: operator => { ctx.settings.set(OPERATOR_KEY, operator) },
    logout: () => { ctx.settings.set<string | null>(OPERATOR_KEY, null) },
    snapshots,
  }
  worlds.push(world)
  return world
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The latest broadcast snapshot once its anchor count reaches `count`. */
function atCount(world: World, count: number): ProductionStatsSnapshot | undefined {
  const latest = world.snapshots.at(-1)
  return latest?.anchor?.count === count ? latest : undefined
}

describe('shift bucketing', () => {
  it('maps wall-clock hours onto the three shifts', () => {
    const at = (hour: number, minute = 0): number => new Date(2026, 7, 30, hour, minute).getTime()
    expect(shiftOf(at(0))).toBe('night')
    expect(shiftOf(at(7, 59))).toBe('night')
    expect(shiftOf(at(8))).toBe('morning')
    expect(shiftOf(at(15, 59))).toBe('morning')
    expect(shiftOf(at(16))).toBe('middle')
    expect(shiftOf(at(23, 59))).toBe('middle')
  })

  it('keys a bucket by its local date', () => {
    expect(shiftKeyOf(new Date(2026, 7, 30, 9).getTime())).toBe('2026-08-30:morning')
    expect(shiftKeyOf(new Date(2026, 7, 30, 23, 30).getTime())).toBe('2026-08-30:middle')
  })
})

describe('production-stats', () => {
  it('accumulates positive deltas only and buckets the current hour', async () => {
    const world = await makeWorld()
    world.login('1001')
    world.drive(COUNT, 0)
    world.drive(COUNT, 12)
    world.drive(COUNT, 20)
    const snap = await waitFor('count 20', () => atCount(world, 20))
    expect(snap.anchor?.operator).toBe('1001')
    expect(snap.anchor?.shift).toBe(shiftOf(Date.now()))
    const hourStart = new Date().setMinutes(0, 0, 0)
    expect(snap.hours.find(bucket => bucket.hourStart === hourStart)?.count).toBe(20)
    // The anchored row rides along with its live count.
    expect(snap.shifts[0]?.shiftKey).toBe(snap.anchor?.shiftKey)
    expect(snap.shifts[0]?.count).toBe(20)

    // A device counter reset (negative delta) must not subtract.
    world.drive(COUNT, 5)
    world.drive(COUNT, 8)
    await waitFor('count 23', () => atCount(world, 23))
    // An abnormal round re-seeds: 30 only seeds, 35 adds 5.
    world.drive(COUNT, null)
    world.drive(COUNT, 30)
    await waitFor('reseeded baseline', () => atCount(world, 23))
    world.drive(COUNT, 35)
    await waitFor('count 28', () => atCount(world, 28))
  })

  it('counts nothing while nobody is signed on; a fresh session seeds from the current value', async () => {
    const world = await makeWorld()
    world.drive(COUNT, 10)
    world.drive(COUNT, 15)
    await waitFor('first frame', () => world.snapshots.at(-1))
    expect(world.snapshots.at(-1)?.anchor).toBeNull()

    world.login('1001')
    world.drive(COUNT, 20)
    await waitFor('seeded session', () => atCount(world, 0))
    world.drive(COUNT, 25)
    await waitFor('count 5', () => atCount(world, 5))
  })

  it('continues the same shift across a logout/re-login', async () => {
    const world = await makeWorld()
    world.login('1001')
    world.drive(COUNT, 0)
    world.drive(COUNT, 10)
    await waitFor('count 10', () => atCount(world, 10))

    world.logout()
    await waitFor('signed off', () => world.snapshots.at(-1)?.anchor === null ? world.snapshots.at(-1) : undefined)
    // Samples while signed out count nowhere.
    world.drive(COUNT, 15)

    world.login('1001')
    const snap = await waitFor('session restored', () => atCount(world, 10))
    expect(snap.anchor?.shiftKey).toBe(shiftKeyOf(Date.now()))
    // The persisted baseline (10) rides along: the re-login's first delta
    // covers the handover gap, then continues.
    world.drive(COUNT, 20)
    await waitFor('count 20', () => atCount(world, 20))
  })

  it('re-seeds when the counting binding changes', async () => {
    const world = await makeWorld()
    world.login('1001')
    world.drive(COUNT, 0)
    world.drive(COUNT, 10)
    await waitFor('count 10', () => atCount(world, 10))

    world.ctx.settings.set('production.countBinding', { device: 'plc1', group: '产量', name: '成品计数' })
    // The old address no longer feeds the counter.
    world.drive(COUNT, 100)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(world.snapshots.at(-1)?.anchor?.count).toBe(10)
    // The new address seeds, then counts.
    world.drive(ALT, 5)
    world.drive(ALT, 8)
    await waitFor('count 13', () => atCount(world, 13))
  })

  it('restores the count and the login anchor across a host restart', async () => {
    const first = await makeWorld()
    first.login('1001')
    first.drive(COUNT, 0)
    first.drive(COUNT, 12)
    first.drive(COUNT, 20)
    const before = await waitFor('count 20', () => atCount(first, 20))
    const home = first.home
    const loginAt = before.anchor?.loginAt
    expect(loginAt).toBeDefined()
    const index = worlds.indexOf(first)
    worlds.splice(index, 1)
    await first.ctx.fiber.dispose()

    const next = await makeWorld(home)
    const restored = await waitFor('restored count 20', () => atCount(next, 20))
    // The persisted anchor keeps the original login time — only a re-login
    // re-picks the shift, a restart must not.
    expect(restored.anchor?.operator).toBe('1001')
    expect(restored.anchor?.loginAt).toBe(loginAt)
    expect(restored.anchor?.shiftKey).toBe(before.anchor?.shiftKey)

    next.drive(COUNT, 25)
    await waitFor('counting continues at 25', () => atCount(next, 25))
  })
})
