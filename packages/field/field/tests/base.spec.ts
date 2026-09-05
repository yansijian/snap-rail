import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import storePlugin from '@snap-rail/store'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin, {
  ConnectionId,
  FieldError,
  pointKey,
  type ConnectionSnapshot,
  type DriverConnection,
  type DriverDevice,
  type DriverHandle,
  type DriverPoint,
  type PointDescriptor,
  type PointRef,
} from '../src/index.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
})

/** The rig driver: records lifecycle calls, samples on demand. */
interface RigDriver {
  plugin: (ctx: Context) => void
  created: DriverDevice[]
  updates: Array<{ device: string, config: unknown }>
  disposed: string[]
  handles: Map<string, DriverHandle>
  points: Map<string, readonly DriverPoint[]>
  /** When set, createConnection throws — the schema-drift fixture. */
  failCreate: boolean
}

function makeRigDriver(): RigDriver {
  const rig: RigDriver = {
    created: [],
    updates: [],
    disposed: [],
    handles: new Map(),
    points: new Map(),
    failCreate: false,
    plugin: undefined as never,
  }
  rig.plugin = Object.assign(function rigDriver(ctx: Context): void {
    ctx.field.registerDriver(ctx, {
      id: 'rig',
      title: 'Rig',
      schemas: {
        device: z.object({ rate: z.number().int().min(1).default(1) }).strict(),
        point: z.object({ type: z.enum(['bool', 'int', 'float', 'string']), factor: z.number().optional() }).strict(),
      },
      createConnection: (device, points, handle): DriverConnection => {
        if (rig.failCreate) throw new Error('dialect drifted')
        rig.created.push({ id: device.id, name: device.name, config: device.config })
        rig.handles.set(device.id, handle)
        rig.points.set(device.id, points)
        return {
          update(next, nextPoints): void {
            rig.updates.push({ device: next.id, config: next.config })
            rig.points.set(next.id, nextPoints)
          },
          dispose(): void {
            rig.disposed.push(device.id)
            rig.handles.delete(device.id)
          },
        }
      },
    })
  }, { inject: ['field'] })
  return rig
}

interface World {
  ctx: Context
  rig: RigDriver
  structureChanges: number
  pointAdded: string[]
  pointRemoved: string[]
  connectionAdded: string[]
  connectionRemoved: string[]
}

async function makeWorld(opts: { failCreate?: boolean } = {}): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-field-base-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(fieldPlugin)
  const rig = makeRigDriver()
  rig.failCreate = opts.failCreate === true
  await ctx.plugin(rig.plugin)

  const world: World = {
    ctx,
    rig,
    structureChanges: 0,
    pointAdded: [],
    pointRemoved: [],
    connectionAdded: [],
    connectionRemoved: [],
  }
  ctx.topic.subscribe(ctx, 'field/structure-changed', undefined, () => { world.structureChanges += 1 })
  ctx.topic.subscribe<{ point: PointDescriptor }>(ctx, 'field/point-added', undefined, payload => world.pointAdded.push(pointKey(payload.point)))
  ctx.topic.subscribe<{ device: string, group: string, name: string }>(ctx, 'field/point-removed', undefined, payload => world.pointRemoved.push(pointKey(payload)))
  ctx.topic.subscribe<{ connection: ConnectionSnapshot }>(ctx, 'field/connection-added', undefined, payload => world.connectionAdded.push(payload.connection.id))
  ctx.topic.subscribe<{ id: ConnectionId }>(ctx, 'field/connection-removed', undefined, payload => world.connectionRemoved.push(payload.id))
  return world
}

/** Create a device with one float group and two points, the common fixture. */
async function seedRigDevice(world: World, name = 'rig-1'): Promise<string> {
  const device = world.ctx.field.upsertDevice({ name, driver: 'rig', config: { rate: 2 } })
  world.ctx.field.upsertGroup(device.id, { name: 'main', type: 'float' })
  world.ctx.field.upsertPoint(device.id, 'main', { name: 'temp', config: { factor: 3 } })
  world.ctx.field.upsertPoint(device.id, 'main', { name: 'flow', config: {} })
  return device.id
}

describe('field base: configuration tables', () => {
  it('creates devices, groups, and points with driver-validated configs', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)

    // Device defaults materialize (rate validated through the driver schema).
    const config = world.ctx.field.config()
    expect(config.devices).toHaveLength(1)
    expect(config.devices[0]).toMatchObject({ id, name: 'rig-1', driver: 'rig', config: { rate: 2 } })
    expect(config.devices[0]?.groups[0]).toMatchObject({ name: 'main', type: 'float' })
    // Points read back in table order (by name within the group).
    expect(config.devices[0]?.groups[0]?.points.map(point => point.name)).toEqual(['flow', 'temp'])
    // The point config is the dialect part alone — `type` never stores.
    expect(config.devices[0]?.groups[0]?.points[1]).toEqual({ name: 'temp', config: { factor: 3 } })

    // The driver saw exactly one connection carrying every row.
    expect(world.rig.created).toEqual([{ id, name: 'rig-1', config: { rate: 2 } }])
    expect(world.rig.points.get(id)?.map(point => [point.name, point.type])).toEqual([['flow', 'float'], ['temp', 'float']])
    expect(world.pointAdded).toEqual([`${id}/main/temp`, `${id}/main/flow`])
  })

  it('rejects configs the driver schema refuses, without partial state', async () => {
    const world = await makeWorld()
    expect(() => world.ctx.field.upsertDevice({ name: 'bad', driver: 'rig', config: { rate: 0 } }))
      .toThrow(FieldError)
    try {
      world.ctx.field.upsertDevice({ name: 'bad', driver: 'rig', config: { rate: 0 } })
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('invalid-config')
    }
    expect(world.ctx.field.config().devices).toHaveLength(0)

    const device = world.ctx.field.upsertDevice({ name: 'ok', driver: 'rig', config: {} })
    world.ctx.field.upsertGroup(device.id, { name: 'main', type: 'int' })
    try {
      world.ctx.field.upsertDevice({ name: 'ghost', driver: 'nope', config: {} })
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('unknown-driver')
    }
    try {
      world.ctx.field.upsertPoint(device.id, 'missing', { name: 'x', config: {} })
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('unknown-group')
    }
  })

  it('mints unique device ids from names and keeps ids stable across renames', async () => {
    const world = await makeWorld()
    const first = world.ctx.field.upsertDevice({ name: '炉', driver: 'rig', config: {} })
    const second = world.ctx.field.upsertDevice({ name: '炉', driver: 'rig', config: {} })
    expect(first.id).toBe('炉')
    expect(second.id).toBe('炉-2')

    const renamed = world.ctx.field.upsertDevice({ id: first.id, name: '1号炉', driver: 'rig', config: {} })
    expect(renamed.id).toBe('炉')
    expect(renamed.name).toBe('1号炉')
  })

  it('cascades: removing a device drops its groups and points; a group drops its points', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)
    const removed = [...world.pointAdded]
    world.pointAdded.length = 0

    world.ctx.field.removeGroup(id, 'main')
    expect(world.pointRemoved.sort()).toEqual(removed.sort())
    expect(world.ctx.field.config().devices[0]?.groups).toEqual([])
    // The connection survives with an empty point table.
    expect(world.ctx.points.list()).toEqual([])

    world.pointRemoved.length = 0
    await seedRigDevice(world, 'second')
    world.ctx.field.removeDevice(id)
    expect(world.connectionRemoved).toEqual([id])
    expect(world.ctx.field.config().devices.map(device => device.id)).toEqual(['second'])
  })

  it('retypes an empty group and refuses a typed one', async () => {
    const world = await makeWorld()
    const device = world.ctx.field.upsertDevice({ name: 'd', driver: 'rig', config: {} })
    world.ctx.field.upsertGroup(device.id, { name: 'g', type: 'int' })
    world.ctx.field.upsertGroup(device.id, { name: 'g', type: 'float' })
    expect(world.ctx.field.config().devices[0]?.groups[0]?.type).toBe('float')

    world.ctx.field.upsertPoint(device.id, 'g', { name: 'x', config: {} })
    try {
      world.ctx.field.upsertGroup(device.id, { name: 'g', type: 'bool' })
      expect.unreachable()
    } catch (cause) {
      expect((cause as FieldError).kind).toBe('type-conflict')
    }
  })
})

describe('field base: orchestration', () => {
  it('parks configured devices while their driver is away; registration revives them', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)
    expect(world.ctx.points.list()).toHaveLength(2)

    // The driver row goes away (disabled/unloaded): its connections die with
    // it, the configuration rows stay, and the mapping view stays honest.
    const remount = world.ctx.plugin(world.rig.plugin)
    await remount
    await remount.dispose()
    expect(world.ctx.points.list()).toEqual([])
    expect(world.ctx.connections.list()).toEqual([])
    expect(world.ctx.field.config().devices).toHaveLength(1)
    expect(world.ctx.field.mappings().devices).toEqual([])

    // The driver comes back: everything configured under it goes live again.
    const revived = world.ctx.plugin(world.rig.plugin)
    await revived
    expect(world.ctx.points.list().map(point => pointKey(point))).toEqual([`${id}/main/flow`, `${id}/main/temp`])
    expect(world.ctx.field.mappings().devices).toEqual([{ id, driver: 'rig' }])
  })

  it('updates live connections in place on config and point changes', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)
    // The seed's two point upserts reached the controller; the group upsert
    // in between changed nothing for the driver and was skipped.
    expect(world.rig.updates).toHaveLength(2)

    // A point lands: setPoints diffs it in, the controller sees update()
    // on the next microtask (the hop keeps sync throws out of the RPC).
    world.ctx.field.upsertPoint(id, 'main', { name: 'extra', config: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(world.pointAdded.at(-1)).toBe(`${id}/main/extra`)
    expect(world.rig.updates).toHaveLength(3)
    expect(world.rig.points.get(id)).toHaveLength(3)

    // A device config change rides update() without a rebuild.
    world.ctx.field.upsertDevice({ id, name: 'rig-1', driver: 'rig', config: { rate: 5 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(world.rig.updates).toHaveLength(4)
    expect(world.rig.updates[3]?.config).toEqual({ rate: 5 })
    expect(world.rig.created).toHaveLength(1)
    expect(world.rig.disposed).toEqual([])
  })

  it('parks a device whose driver refuses its connection, without failing mutations', async () => {
    const world = await makeWorld({ failCreate: true })
    // The upserts land (the tables are the source of truth); the driver's
    // refusal parks the device lifeless instead of failing the mutation.
    const device = world.ctx.field.upsertDevice({ name: 'drift', driver: 'rig', config: {} })
    world.ctx.field.upsertGroup(device.id, { name: 'g', type: 'int' })
    expect(world.ctx.field.upsertPoint(device.id, 'g', { name: 'p', config: {} })).toEqual({ name: 'p', config: {} })
    expect(world.ctx.connections.list()).toEqual([])
    expect(world.ctx.points.list()).toEqual([])
    // Later mutations keep working (no duplicate-connection explosion).
    expect(() => world.ctx.field.upsertPoint(device.id, 'g', { name: 'p2', config: {} })).not.toThrow()
    expect(world.ctx.field.config().devices[0]?.groups[0]?.points).toHaveLength(2)
  })

  it('rebuilds the connection when the device renames; re-registration replaces', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)

    world.ctx.field.upsertDevice({ id, name: '改名', driver: 'rig', config: {} })
    expect(world.rig.disposed).toEqual([id])
    expect(world.rig.created).toHaveLength(2)
    expect(world.ctx.connections.list()[0]?.title).toBe('改名')

    // Mounting the same driver id again replaces in place: one teardown, one
    // fresh controller, the point table unchanged.
    const rigFiber = world.ctx.plugin(world.rig.plugin)
    await rigFiber
    expect(world.rig.disposed).toEqual([id, id])
    expect(world.rig.created).toHaveLength(3)
    expect(world.ctx.points.list().map(point => pointKey(point))).toHaveLength(2)
  })

  it('serves the aggregated mapping document from its own tables', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)
    const second = world.ctx.field.upsertDevice({ name: 'second', driver: 'rig', config: {} })
    world.ctx.field.upsertGroup(second.id, { name: 'bits', type: 'bool' })
    world.ctx.field.upsertPoint(second.id, 'bits', { name: 'flag', config: {} })

    expect(world.ctx.field.mappings()).toEqual({
      devices: [{ id, driver: 'rig' }, { id: second.id, driver: 'rig' }],
      groups: [
        { deviceId: id, name: 'main', type: 'float' },
        { deviceId: second.id, name: 'bits', type: 'bool' },
      ],
      points: [
        { deviceId: id, group: 'main', name: 'flow' },
        { deviceId: id, group: 'main', name: 'temp' },
        { deviceId: second.id, group: 'bits', name: 'flag' },
      ],
    })
  })

  it('broadcasts structure and mappings changes on every mutation', async () => {
    const world = await makeWorld()
    const mappingsSeen: number[] = []
    world.ctx.topic.subscribe(world.ctx, 'field/mappings-changed', undefined, () => mappingsSeen.push(1))

    const device = world.ctx.field.upsertDevice({ name: 'd', driver: 'rig', config: {} })
    world.ctx.field.upsertGroup(device.id, { name: 'g', type: 'int' })
    world.ctx.field.upsertPoint(device.id, 'g', { name: 'n', config: {} })
    world.ctx.field.removePoint({ device: device.id, group: 'g', name: 'n' })

    expect(world.structureChanges).toBe(4)
    expect(mappingsSeen).toHaveLength(4)
  })
})

describe('field base: connection handle', () => {
  it('wires the driver handle onto the connection registration', async () => {
    const world = await makeWorld()
    const id = await seedRigDevice(world)
    const handle = world.rig.handles.get(id)
    expect(handle).toBeDefined()

    const ref: PointRef = { device: id, group: 'main', name: 'temp' }
    handle?.status('online', '链接正常')
    expect(world.ctx.connections.list()[0]).toMatchObject({ status: 'online', message: '链接正常' })
    handle?.sample(ref, 42)
    expect(world.ctx.points.read(ref)?.value).toBe(42)

    const writes: unknown[] = []
    handle?.onWrite((point, value) => {
      writes.push([pointKey(point), value])
    })
    await world.ctx.points.write(ref, 43.5)
    expect(writes).toEqual([[`${id}/main/temp`, 43.5]])
  })
})
