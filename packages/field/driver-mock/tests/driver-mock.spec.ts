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
import mockDriverPlugin from '../src/index.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
})

interface World {
  ctx: Context
  samples: PointSample[]
}

const refs = {
  flow: { device: 'sim', group: '浮点', name: 'flow' } as const,
  count: { device: 'sim', group: '计数', name: 'count' } as const,
  run: { device: 'sim', group: '布尔', name: 'run' } as const,
  stamp: { device: 'sim', group: '文本', name: 'stamp' } as const,
}

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-driver-mock-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(timerPlugin)
  await ctx.plugin(mockDriverPlugin)

  const samples: PointSample[] = []
  ctx.field.upsertDevice({ name: 'sim', driver: 'mock', config: { periodMs: 10, offline: false } })
  for (const [group, type] of [['浮点', 'float'], ['计数', 'int'], ['布尔', 'bool'], ['文本', 'string']] as const) {
    ctx.field.upsertGroup('sim', { name: group, type })
  }
  ctx.field.upsertPoint('sim', '浮点', { name: 'flow', config: {} })
  ctx.field.upsertPoint('sim', '计数', { name: 'count', config: {} })
  ctx.field.upsertPoint('sim', '布尔', { name: 'run', config: {} })
  ctx.field.upsertPoint('sim', '文本', { name: 'stamp', config: {} })
  ctx.topic.subscribe<PointSample>(ctx, 'field/point-update', { points: [refs.flow, refs.count, refs.run, refs.stamp] }, sample => samples.push(sample))
  return { ctx, samples }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function latest(world: World, ref: PointRef): PointSample | undefined {
  return [...world.samples].reverse().find(sample => pointKey(sample) === pointKey(ref))
}

describe('mock driver over the field base', () => {
  it('streams samples of every semantic type and reports online', async () => {
    const world = await makeWorld()
    await sleep(80)

    expect(world.ctx.connections.list()).toEqual([
      { id: 'sim', driver: 'mock', title: 'sim', status: 'online' },
    ])
    expect(new Set(world.ctx.points.list().map(point => pointKey(point)))).toEqual(new Set([
      'sim/计数/count', 'sim/布尔/run', 'sim/文本/stamp', 'sim/浮点/flow',
    ]))

    const flow = latest(world, refs.flow)?.value
    expect(typeof flow).toBe('number')
    expect(flow as number).toBeGreaterThanOrEqual(0)
    expect(flow as number).toBeLessThanOrEqual(100)

    const count = latest(world, refs.count)?.value
    expect(typeof count).toBe('bigint')
    expect(count as bigint).toBeGreaterThan(0n)

    expect(latest(world, refs.run)?.value).toBeTypeOf('boolean')
    expect(latest(world, refs.stamp)?.value).toBeTypeOf('string')
  })

  it('echoes writes back as samples', async () => {
    const world = await makeWorld()
    await sleep(30)

    await world.ctx.points.write(refs.run, true)
    expect(latest(world, refs.run)?.value).toBe(true)

    await world.ctx.points.write(refs.count, 41n)
    expect(latest(world, refs.count)?.value).toBe(41n)
  })

  it('parks with null samples when the device config goes offline', async () => {
    const world = await makeWorld()
    await sleep(30)
    expect(world.ctx.connections.list()[0]?.status).toBe('online')

    world.ctx.field.upsertDevice({ id: 'sim', name: 'sim', driver: 'mock', config: { periodMs: 10, offline: true } })
    await sleep(60)
    expect(world.ctx.connections.list()[0]?.status).toBe('offline')
    expect(latest(world, refs.flow)?.value).toBeNull()
    expect(latest(world, refs.count)?.value).toBeNull()

    // Back online: values resume.
    world.ctx.field.upsertDevice({ id: 'sim', name: 'sim', driver: 'mock', config: { periodMs: 10, offline: false } })
    await sleep(60)
    expect(world.ctx.connections.list()[0]?.status).toBe('online')
    expect(latest(world, refs.count)?.value).not.toBeNull()
  })

  it('hot-adds and removes points through the base', async () => {
    const world = await makeWorld()
    world.ctx.field.upsertPoint('sim', '计数', { name: 'count2', config: {} })
    const count2: PointRef = { device: 'sim', group: '计数', name: 'count2' }
    const seen: unknown[] = []
    world.ctx.topic.subscribe<PointSample>(world.ctx, 'field/point-update', { points: [count2] }, sample => seen.push(sample.value))
    await sleep(60)
    expect(seen.length).toBeGreaterThan(0)

    world.ctx.field.removePoint(count2)
    expect(world.ctx.points.list().map(point => pointKey(point))).not.toContain(pointKey(count2))
  })

  it('drops its connection when the device is removed', async () => {
    const world = await makeWorld()
    await sleep(30)
    world.ctx.field.removeDevice('sim')
    expect(world.ctx.connections.list()).toEqual([])
    expect(world.ctx.points.list()).toEqual([])
  })
})
