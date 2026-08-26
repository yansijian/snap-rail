import { Context } from '@snap-rail/cordis'
import TimerService from '@snap-rail/cordis-plugin-timer'
import { ConnectionId, PointId } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin, { FieldError } from '../../field/src/index.ts'
import mockDriverPlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeField(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TimerService)
  await ctx.plugin(fieldPlugin)
  return ctx
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('mock driver', () => {
  it('streams prefixed samples of every semantic type', async () => {
    const ctx = await makeField()
    const boolSeen: boolean[] = []
    ctx.points.subscribe([PointId('sim.run')], sample => boolSeen.push(sample.value as boolean))

    await ctx.plugin(mockDriverPlugin, {
      connection: 'sim',
      title: 'Simulator',
      offline: false,
      periodMs: 10,
      points: [
        { id: 'flow', type: 'float' },
        { id: 'count', type: 'int' },
        { id: 'run', type: 'bool' },
        { id: 'stamp', type: 'string' },
      ],
    })

    expect(ctx.connections.list()).toEqual([
      { id: ConnectionId('sim'), driver: 'driver-mock', title: 'Simulator', status: 'online' },
    ])
    expect(ctx.points.list().map(point => point.id)).toEqual([
      PointId('sim.flow'), PointId('sim.count'), PointId('sim.run'), PointId('sim.stamp'),
    ])

    await sleep(120)

    const flow = ctx.points.read(PointId('sim.flow'))?.value
    expect(typeof flow).toBe('number')
    expect(flow).toBeGreaterThanOrEqual(0)
    expect(flow).toBeLessThanOrEqual(100)

    expect(typeof ctx.points.read(PointId('sim.count'))?.value).toBe('bigint')
    const c1 = ctx.points.read(PointId('sim.count'))?.value as bigint
    await sleep(35)
    const c2 = ctx.points.read(PointId('sim.count'))?.value as bigint
    expect(c2 > c1).toBe(true)

    expect(boolSeen.length).toBeGreaterThanOrEqual(2)
    expect(boolSeen[0]).toBe(true)
    expect(boolSeen[1]).toBe(false)

    expect(String(ctx.points.read(PointId('sim.stamp'))?.value)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('pushes null samples offline and refuses writes without a handler', async () => {
    const ctx = await makeField()
    await ctx.plugin(mockDriverPlugin, {
      connection: 'dark',
      title: 'Offline rig',
      offline: true,
      periodMs: 10,
      points: [{ id: 'lamp', type: 'bool' }],
    })

    await sleep(40)
    expect(ctx.connections.list()[0]?.status).toBe('offline')
    expect(ctx.points.read(PointId('dark.lamp'))?.value).toBeNull()

    try {
      await ctx.points.write(PointId('dark.lamp'), true)
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('no-write-handler')
    }
  })

  it('echoes writes back as samples and lets instances coexist', async () => {
    const ctx = await makeField()
    await ctx.plugin(mockDriverPlugin, {
      connection: 'echo',
      title: 'Echo rig',
      offline: false,
      periodMs: 60_000,
      points: [{ id: 'setpoint', type: 'float' }],
    })
    await ctx.plugin(mockDriverPlugin, {
      connection: 'other',
      title: 'Second rig',
      offline: false,
      periodMs: 60_000,
      points: [{ id: 'setpoint', type: 'int' }],
    })

    await ctx.points.write(PointId('echo.setpoint'), 42.5)
    // The echo sample replaces the generator's value on the shared handle.
    expect(ctx.points.read(PointId('echo.setpoint'))?.value).toBe(42.5)
    expect(ctx.connections.list().map(connection => connection.id)).toEqual(['echo', 'other'])
  })

  it('fails config validation loudly on duplicate local tags', async () => {
    const ctx = await makeField()
    await expect(ctx.plugin(mockDriverPlugin, {
      connection: 'dupe',
      title: 'Broken',
      offline: false,
      periodMs: 10,
      points: [
        { id: 'a', type: 'int' },
        { id: 'a', type: 'float' },
      ],
    })).rejects.toThrow(/unique/)
    expect(ctx.connections.list()).toEqual([])
  })
})
