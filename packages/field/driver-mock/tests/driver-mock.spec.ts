import { Context } from '@snap-rail/cordis'
import TimerService from '@snap-rail/cordis-plugin-timer'
import { ConnectionId, pointKey, type PointRef } from '@snap-rail/field'
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
  it('streams group-scoped samples of every semantic type', async () => {
    const ctx = await makeField()
    const run: PointRef = { device: 'sim', group: 'main', name: 'run' }
    const boolSeen: boolean[] = []
    ctx.points.subscribe([run], sample => boolSeen.push(sample.value as boolean))

    await ctx.plugin(mockDriverPlugin, {
      connection: 'sim',
      title: 'Simulator',
      offline: false,
      periodMs: 10,
      points: [
        { name: 'flow', group: 'main', type: 'float' },
        { name: 'count', group: 'main', type: 'int' },
        { name: 'run', group: 'main', type: 'bool' },
        { name: 'stamp', group: 'main', type: 'string' },
      ],
    })

    expect(ctx.connections.list()).toEqual([
      { id: ConnectionId('sim'), driver: 'driver-mock', title: 'Simulator', status: 'online' },
    ])
    expect(ctx.points.list().map(point => pointKey(point))).toEqual([
      'sim/main/flow', 'sim/main/count', 'sim/main/run', 'sim/main/stamp',
    ])

    await sleep(120)

    const flow = ctx.points.read({ device: 'sim', group: 'main', name: 'flow' })?.value
    expect(typeof flow).toBe('number')
    expect(flow).toBeGreaterThanOrEqual(0)
    expect(flow).toBeLessThanOrEqual(100)

    const countRef = { device: 'sim', group: 'main', name: 'count' }
    expect(typeof ctx.points.read(countRef)?.value).toBe('bigint')
    const c1 = ctx.points.read(countRef)?.value as bigint
    await sleep(35)
    const c2 = ctx.points.read(countRef)?.value as bigint
    expect(c2 > c1).toBe(true)

    expect(boolSeen.length).toBeGreaterThanOrEqual(2)
    expect(boolSeen[0]).toBe(true)
    expect(boolSeen[1]).toBe(false)

    expect(String(ctx.points.read({ device: 'sim', group: 'main', name: 'stamp' })?.value)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('pushes null samples offline and refuses writes without a handler', async () => {
    const ctx = await makeField()
    await ctx.plugin(mockDriverPlugin, {
      connection: 'dark',
      title: 'Offline rig',
      offline: true,
      periodMs: 10,
      points: [{ name: 'lamp', group: 'main', type: 'bool' }],
    })

    await sleep(40)
    expect(ctx.connections.list()[0]?.status).toBe('offline')
    expect(ctx.points.read({ device: 'dark', group: 'main', name: 'lamp' })?.value).toBeNull()

    try {
      await ctx.points.write({ device: 'dark', group: 'main', name: 'lamp' }, true)
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
      points: [{ name: 'setpoint', group: 'main', type: 'float' }],
    })
    await ctx.plugin(mockDriverPlugin, {
      connection: 'other',
      title: 'Second rig',
      offline: false,
      periodMs: 60_000,
      points: [{ name: 'setpoint', group: 'main', type: 'int' }],
    })

    await ctx.points.write({ device: 'echo', group: 'main', name: 'setpoint' }, 42.5)
    // The echo sample replaces the generator's value on the shared handle.
    expect(ctx.points.read({ device: 'echo', group: 'main', name: 'setpoint' })?.value).toBe(42.5)
    expect(ctx.connections.list().map(connection => connection.id)).toEqual(['echo', 'other'])
  })

  it('fails config validation loudly on duplicate group-scoped names', async () => {
    const ctx = await makeField()
    await expect(ctx.plugin(mockDriverPlugin, {
      connection: 'dupe',
      title: 'Broken',
      offline: false,
      periodMs: 10,
      points: [
        { name: 'a', group: 'main', type: 'int' },
        { name: 'a', group: 'main', type: 'float' },
      ],
    })).rejects.toThrow(/unique/)
    expect(ctx.connections.list()).toEqual([])
  })
})
