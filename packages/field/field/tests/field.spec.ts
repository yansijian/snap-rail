import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import storePlugin from '@snap-rail/store'
import { ConnectionId, pointKey, type ConnectionStatusFrame, type PointDescriptor, type PointRef, type PointSample, type PointType } from '@snap-rail/field'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin, { FieldError } from '../src/index.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
})

async function makeField(): Promise<Context> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-field-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(fieldPlugin)
  return ctx
}

function descriptor(connection: string, name: string, type: PointType = 'float', group = 'main'): PointDescriptor {
  return { device: connection, group, name, connection: ConnectionId(connection), type }
}

function ref(device: string, name: string, group = 'main'): PointRef {
  return { device, group, name }
}

describe('field seam', () => {
  it('diffs setPoints into added/removed topics', async () => {
    const ctx = await makeField()
    const added: string[] = []
    const removed: string[] = []
    ctx.topic.subscribe<{ point: PointDescriptor }>(ctx, 'field/point-added', undefined, payload => added.push(pointKey(payload.point)))
    ctx.topic.subscribe<{ device: string, group: string, name: string }>(ctx, 'field/point-removed', undefined, payload => removed.push(pointKey(payload)))

    const registration = ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'A' })
    registration.setPoints([
      descriptor('conn-a', 'one'),
      descriptor('conn-a', 'two'),
    ])
    expect(added).toEqual(['conn-a/main/one', 'conn-a/main/two'])

    registration.setPoints([
      descriptor('conn-a', 'two'),
      descriptor('conn-a', 'three'),
    ])
    expect(added).toEqual(['conn-a/main/one', 'conn-a/main/two', 'conn-a/main/three'])
    expect(removed).toEqual(['conn-a/main/one'])
    expect(ctx.points.list().map(point => pointKey(point))).toEqual(['conn-a/main/two', 'conn-a/main/three'])
  })

  it('rejects duplicate connections and cross-owner points without partial state', async () => {
    const ctx = await makeField()
    const registration = ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'A' })
    registration.setPoints([descriptor('conn-a', 'shared')])

    try {
      ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'again' })
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('duplicate-connection')
    }

    const second = ctx.connections.register(ctx, { id: ConnectionId('conn-b'), driver: 'test', title: 'B' })
    // The same address claimed through another connection: conn-b declares a
    // point on device conn-a, which conn-a already owns.
    expect(() => second.setPoints([
      descriptor('conn-b', 'mine'),
      { device: 'conn-a', group: 'main', name: 'shared', connection: ConnectionId('conn-b'), type: 'float' },
    ])).toThrow(/already registered/)
    // The rejected call mutated nothing.
    expect(ctx.points.list().map(point => pointKey(point))).toEqual(['conn-a/main/shared'])
  })

  it('moves samples through read and rejects unknown sampling', async () => {
    const ctx = await makeField()
    const registration = ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'A' })
    registration.setPoints([descriptor('conn-a', 'one')])

    expect(ctx.points.read(ref('conn-a', 'one'))).toBeUndefined()
    registration.sample(ref('conn-a', 'one'), 12.5)
    expect(ctx.points.read(ref('conn-a', 'one'))?.value).toBe(12.5)

    expect(() => registration.sample(ref('conn-a', 'ghost'), 1))
      .toThrow(FieldError)
    expect(ctx.points.read(ref('conn-a', 'ghost'))).toBeUndefined()
  })

  it('routes writes to the owner with type checks and handler lifecycle', async () => {
    const ctx = await makeField()
    try {
      await ctx.points.write(ref('nowhere', 'x'), 1n)
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('unknown-point')
    }

    const readOnly = ctx.connections.register(ctx, { id: ConnectionId('ro'), driver: 'test', title: 'RO' })
    readOnly.setPoints([descriptor('ro', 'tag', 'string')])
    try {
      await ctx.points.write(ref('ro', 'tag'), 'x')
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('no-write-handler')
    }

    const received: Array<[PointDescriptor, string]> = []
    const writable = ctx.connections.register(ctx, { id: ConnectionId('rw'), driver: 'test', title: 'RW' })
    writable.setPoints([descriptor('rw', 'tag', 'string')])
    writable.setWriteHandler((point, value) => {
      received.push([point, value])
    })

    await ctx.points.write(ref('rw', 'tag'), 'open')
    expect(received).toEqual([[descriptor('rw', 'tag', 'string'), 'open']])

    for (const bad of [true, 3n]) {
      try {
        await ctx.points.write(ref('rw', 'tag'), bad as never)
        expect.unreachable()
      } catch (cause) {
        expect((cause as FieldError).kind).toBe('type-mismatch')
      }
    }
  })

  it('keeps BigInt values lossless through subscription filtering', async () => {
    const ctx = await makeField()
    const seen: unknown[] = []
    const unsubscribe = ctx.topic.subscribe<PointSample>(ctx, 'field/point-update', { points: [ref('conn-a', 'big')] }, sample => seen.push(sample.value))

    const registration = ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'A' })
    registration.setPoints([
      descriptor('conn-a', 'big', 'int'),
      descriptor('conn-a', 'side'),
    ])
    const huge = 9_007_199_254_740_993n
    registration.sample(ref('conn-a', 'side'), 1.5)
    registration.sample(ref('conn-a', 'big'), huge)
    registration.sample(ref('conn-a', 'big'), huge + 2n)

    await new Promise(resolve => setTimeout(resolve, 0))
    unsubscribe()
    expect(seen).toEqual([huge, huge + 2n])
  })

  it('announces status only on change and reflects live snapshots', async () => {
    const ctx = await makeField()
    const frames: string[] = []
    ctx.topic.subscribe<ConnectionStatusFrame>(ctx, 'field/connection-status', undefined, frame => frames.push(`${frame.id}:${frame.status}`))

    const registration = ctx.connections.register(ctx, { id: ConnectionId('conn-a'), driver: 'test', title: 'A' })
    // A fresh registration starts connecting until its driver announces up.
    expect(ctx.connections.list()).toEqual([
      { id: ConnectionId('conn-a'), driver: 'test', title: 'A', status: 'connecting' },
    ])
    registration.setStatus('online')
    registration.setStatus('online')
    registration.setStatus('offline')

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(frames).toEqual(['conn-a:online', 'conn-a:offline'])
    expect(ctx.connections.list()[0]?.status).toBe('offline')
  })

  it('removes a connection when its registering fiber unloads', async () => {
    const ctx = await makeField()
    const removed: string[] = []
    let connectionRemoved: string | undefined
    ctx.topic.subscribe<{ device: string, group: string, name: string }>(ctx, 'field/point-removed', undefined, payload => removed.push(pointKey(payload)))
    ctx.topic.subscribe<{ id: ConnectionId }>(ctx, 'field/connection-removed', undefined, payload => { connectionRemoved = payload.id })

    const mockDriver = Object.assign(
      function mockDriver(sub: Context): void {
        const registration = sub.connections.register(sub, { id: ConnectionId('drip'), driver: 'test', title: 'D' })
        registration.setPoints([
          descriptor('drip', 'one'),
          descriptor('drip', 'two'),
        ])
      },
      { inject: ["connections"] },
    )
    const fiber = ctx.plugin(mockDriver)
    await fiber
    expect(ctx.connections.list()).toHaveLength(1)
    expect(ctx.points.list()).toHaveLength(2)

    // An explicit early dispose must not double-emit on fiber unload.
    fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    fiber.dispose()

    expect(removed.sort()).toEqual(['drip/main/one', 'drip/main/two'])
    expect(connectionRemoved).toBe(ConnectionId('drip'))
    expect(ctx.connections.list()).toEqual([])
    expect(ctx.points.list()).toEqual([])
  })
})
