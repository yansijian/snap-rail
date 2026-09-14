import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import storePlugin from '@snap-rail/store-sqlite'
import { pointKey, type PointRef, type PointSample } from '@snap-rail/equipment'
import { afterEach, describe, expect, it } from 'vitest'
import equipmentPlugin from '../../equipment/src/index.ts'
import enipDriverPlugin from '../src/index.ts'
import { CIP_BOOL, CIP_DINT, CIP_REAL, SERVICE_UNCONNECTED_SEND } from '../src/enip.ts'
import { startFakePlc } from './fake-plc.ts'

const worlds: Array<{ ctx: Context, home: string }> = []
const servers: Array<{ close: (cb: () => void) => void }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
})

interface World {
  ctx: Context
  samples: PointSample[]
  statuses: Array<{ id: string, status: string }>
}

const tempRef: PointRef = { device: 'plc1', group: '温度', name: '温度1' }
const countRef: PointRef = { device: 'plc1', group: '计数', name: '计数1' }
const switchRef: PointRef = { device: 'plc1', group: '开关', name: '开关1' }
const missingRef: PointRef = { device: 'plc1', group: '计数', name: '缺失1' }

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-driver-enip-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(equipmentPlugin)
  await ctx.plugin(timerPlugin)
  await ctx.plugin(enipDriverPlugin)
  const samples: PointSample[] = []
  const statuses: Array<{ id: string, status: string }> = []
  ctx.points.subscribe([tempRef, countRef, switchRef, missingRef], sample => samples.push(sample))
  ctx.connections.subscribeStatus(frame => statuses.push({ id: frame.id, status: frame.status }))
  return { ctx, samples, statuses }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One enabled device with three mapped variables, created through the base. */
function seedDevice(ctx: Context, port: number): void {
  ctx.equipment.upsertDevice({
    name: 'plc1',
    driver: 'enip',
    config: { host: '127.0.0.1', port, pollMs: 60, timeoutMs: 250 },
  })
  ctx.equipment.upsertGroup('plc1', { name: '温度', type: 'float' })
  ctx.equipment.upsertGroup('plc1', { name: '计数', type: 'int' })
  ctx.equipment.upsertGroup('plc1', { name: '开关', type: 'bool' })
  ctx.equipment.upsertPoint('plc1', '温度', {
    name: '温度1',
    config: { tag: 'Temp' },
  })
  ctx.equipment.upsertPoint('plc1', '计数', {
    name: '计数1',
    config: { tag: 'Count' },
  })
  ctx.equipment.upsertPoint('plc1', '开关', {
    name: '开关1',
    config: { tag: 'Switch', writable: true },
  })
}

/** The published variable table every scene starts from. */
function seedTags(plc: { tags: Map<string, { type: number, value: boolean | number | bigint }> }): void {
  plc.tags.set('Temp', { type: CIP_REAL, value: 100 })
  plc.tags.set('Count', { type: CIP_DINT, value: 7 })
  plc.tags.set('Switch', { type: CIP_BOOL, value: false })
}

function latestSample(samples: PointSample[], ref: PointRef): PointSample | undefined {
  return [...samples].reverse().find(sample => pointKey(sample) === pointKey(ref))
}

describe('driver-enip over the equipment base', () => {
  it('speaks the zero-sender register and wrapped-read dialect on the wire', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')
    await waitFor(() => latestSample(world.samples, tempRef) !== undefined, 'first temperature')

    // ab_server rejects a nonzero sender context on RegisterSession with the
    // cryptic "ENIP command 0x65 failed with status 1"; the register rides
    // zero and nothing else.
    expect(plc.wire.registers).toEqual([0n])
    // Every tag request arrives wrapped in an Unconnected Send — the bare
    // symbolic form is what unconnected routers reject with CIP status 8.
    expect(plc.wire.services.length).toBeGreaterThan(0)
    expect(plc.wire.services.every(service => service === SERVICE_UNCONNECTED_SEND)).toBe(true)
  }, 15_000)

  it('polls, decodes, and reports the first observation once online', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)

    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')
    // The driver announces online once the session stands, before the first
    // variable round-trip lands — wait for the observations themselves.
    await waitFor(() => latestSample(world.samples, tempRef) !== undefined, 'first temperature')
    const temperature = latestSample(world.samples, tempRef)
    expect(temperature?.value).toBeCloseTo(100)
    expect(latestSample(world.samples, countRef)?.value).toBe(7n)
    expect(latestSample(world.samples, switchRef)?.value).toBe(false)
  }, 15_000)

  it('reports only on change', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'first count')

    // Several quiet polls: no new 计数1 frames.
    await new Promise(resolve => setTimeout(resolve, 250))
    const countAfterQuiet = world.samples.filter(sample => pointKey(sample) === pointKey(countRef)).length
    expect(countAfterQuiet).toBe(1)

    // The variable moves: exactly one fresh frame carries it.
    plc.tags.get('Count')!.value = 8
    await waitFor(() => latestSample(world.samples, countRef)?.value === 8n, 'changed count')
    expect(world.samples.filter(sample => pointKey(sample) === pointKey(countRef))).toHaveLength(2)
  }, 15_000)

  it('writes variables through the equipment seam and echoes the sample', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')

    await world.ctx.points.write(switchRef, true)
    await waitFor(() => plc.tags.get('Switch')?.value === true, 'variable state on the wire')
    await waitFor(() => latestSample(world.samples, switchRef)?.value === true, 'echo sample')
  }, 15_000)

  it('goes offline with one null round and recovers when the PLC returns', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')

    await plc.stop()
    await waitFor(() => world.statuses.at(-1)?.status === 'offline', 'offline')
    expect(latestSample(world.samples, countRef)?.value).toBeNull()

    // Quiet while down: exactly one null round per point.
    const nulls = world.samples.filter(sample => sample.value === null).length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(world.samples.filter(sample => sample.value === null).length).toBe(nulls)

    await plc.restart(server => servers.push(server))
    await waitFor(() => world.statuses.at(-1)?.status === 'online', 'recovered')
    // null → value is a change: values re-report without being re-seeded.
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'value re-reported')
  }, 20_000)

  it('hot-applies point additions through the base and drops the link on device removal', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)
    plc.tags.set('Count2', { type: CIP_DINT, value: 42 })

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'first count')

    // A second counter lands in the same group: the variable map re-maps live.
    world.ctx.equipment.upsertPoint('plc1', '计数', {
      name: '计数2',
      config: { tag: 'Count2' },
    })
    const count2: PointRef = { device: 'plc1', group: '计数', name: '计数2' }
    world.ctx.points.subscribe([count2], sample => world.samples.push(sample))
    await waitFor(() => latestSample(world.samples, count2)?.value === 42n, 'hot-added point')
    expect(world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online')).toBe(true)

    // Device removal tears the connection and the point table with it.
    world.ctx.equipment.removeDevice('plc1')
    expect(world.ctx.connections.list()).toEqual([])
    expect(world.ctx.points.list()).toEqual([])
  }, 20_000)

  it('reports an unknown variable as one null while the device stays online', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    seedTags(plc)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    // A point whose variable was never published: the CIP reply fails, the
    // point carries one null, and the link itself never wavers.
    world.ctx.equipment.upsertPoint('plc1', '计数', {
      name: '缺失1',
      config: { tag: 'Missing' },
    })

    await waitFor(() => latestSample(world.samples, missingRef)?.value === null, 'null for the missing variable')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(world.samples.filter(sample => pointKey(sample) === pointKey(missingRef))).toHaveLength(1)
    expect(world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'offline')).toBe(false)

    // The healthy variable keeps reporting changes.
    plc.tags.get('Count')!.value = 9
    await waitFor(() => latestSample(world.samples, countRef)?.value === 9n, 'healthy variable still live')
  }, 15_000)
})
