import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import gatewayPlugin from '@snap-rail/gateway'
import storePlugin from '@snap-rail/store'
import { pointKey, type PointRef, type PointSample } from '@snap-rail/field'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin from '../../field/src/index.ts'
import modbusDriverPlugin from '../src/index.ts'
import { floatRegs, startFakePlc } from './fake-plc.ts'

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

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-driver-modbus-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(timerPlugin)
  await ctx.plugin(modbusDriverPlugin)
  const samples: PointSample[] = []
  const statuses: Array<{ id: string, status: string }> = []
  ctx.topic.subscribe<PointSample>(ctx, 'field/point-update', { points: [tempRef, countRef, switchRef] }, sample => samples.push(sample))
  ctx.topic.subscribe<{ id: string, status: string }>(ctx, 'field/connection-status', undefined, frame => statuses.push({ id: frame.id, status: frame.status }))
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
  ctx.field.upsertDevice({
    name: 'plc1',
    driver: 'modbus',
    config: { host: '127.0.0.1', port, unitId: 1, pollMs: 60, timeoutMs: 250 },
  })
  ctx.field.upsertGroup('plc1', { name: '温度', type: 'float' })
  ctx.field.upsertGroup('plc1', { name: '计数', type: 'int' })
  ctx.field.upsertGroup('plc1', { name: '开关', type: 'bool' })
  ctx.field.upsertPoint('plc1', '温度', {
    name: '温度1',
    config: { fc: 3, address: 100, encoding: 'f32', writable: false },
  })
  ctx.field.upsertPoint('plc1', '计数', {
    name: '计数1',
    config: { fc: 3, address: 104, encoding: 'u32' },
  })
  ctx.field.upsertPoint('plc1', '开关', {
    name: '开关1',
    config: { fc: 1, address: 10, encoding: 'coil', writable: true },
  })
}

function latestSample(samples: PointSample[], ref: PointRef): PointSample | undefined {
  return [...samples].reverse().find(sample => pointKey(sample) === pointKey(ref))
}

describe('driver-modbus over the field base', () => {
  it('polls, decodes, and reports the first observation once online', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    plc.holding.set(100, floatRegs(100)[0] as number) // f32 raw 100.0
    plc.holding.set(101, floatRegs(100)[1] as number)
    plc.holding.set(104, 0)
    plc.holding.set(105, 7) // u32 = 7

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)

    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')
    const temperature = latestSample(world.samples, tempRef)
    expect(temperature?.value).toBeCloseTo(100)
    expect(latestSample(world.samples, countRef)?.value).toBe(7n)
    expect(latestSample(world.samples, switchRef)?.value).toBe(false)
  }, 15_000)

  it('reports only on change', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    plc.holding.set(105, 7)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'first count')

    // Several quiet polls: no new 计数1 frames.
    await new Promise(resolve => setTimeout(resolve, 250))
    const countAfterQuiet = world.samples.filter(sample => pointKey(sample) === pointKey(countRef)).length
    expect(countAfterQuiet).toBe(1)

    // The value moves: exactly one fresh frame carries it.
    plc.holding.set(105, 8)
    await waitFor(() => latestSample(world.samples, countRef)?.value === 8n, 'changed count')
    expect(world.samples.filter(sample => pointKey(sample) === pointKey(countRef))).toHaveLength(2)
  }, 15_000)

  it('writes coils through the field seam and echoes the sample', async () => {
    const plc = await startFakePlc(server => servers.push(server))

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')

    await world.ctx.points.write(switchRef, true)
    await waitFor(() => plc.coils.get(10) === true, 'coil state on the wire')
    await waitFor(() => latestSample(world.samples, switchRef)?.value === true, 'echo sample')
  }, 15_000)

  it('goes offline with one null round and recovers when the PLC returns', async () => {
    const plc = await startFakePlc(server => servers.push(server))
    plc.holding.set(105, 7)

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
    plc.holding.set(105, 7)

    const world = await makeWorld()
    seedDevice(world.ctx, plc.port)
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'first count')

    // A second counter lands in the same group: the poll plan re-plans live.
    world.ctx.field.upsertPoint('plc1', '计数', {
      name: '计数2',
      config: { fc: 3, address: 106, encoding: 'u16' },
    })
    plc.holding.set(106, 42)
    const count2: PointRef = { device: 'plc1', group: '计数', name: '计数2' }
    world.ctx.topic.subscribe<PointSample>(world.ctx, 'field/point-update', { points: [count2] }, sample => world.samples.push(sample))
    await waitFor(() => latestSample(world.samples, count2)?.value === 42n, 'hot-added point')
    expect(world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online')).toBe(true)

    // Device removal tears the connection and the point table with it.
    world.ctx.field.removeDevice('plc1')
    expect(world.ctx.connections.list()).toEqual([])
    expect(world.ctx.points.list()).toEqual([])
  }, 20_000)
})
