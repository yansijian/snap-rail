import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import { InProcessApiClient, type ServerRequest } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import gatewayPlugin from '@snap-rail/gateway'
import fieldPlugin, { ConnectionId, pointKey, type ConnectionRegistration, type PointRef } from '../src/index.ts'
import fieldRpcPlugin from '../src/rpc.ts'

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
  auditFile: string
  /** Drives samples and status on the mounted writable test connection. */
  drive: ConnectionRegistration
}

const temp: PointRef = { device: 'conn-1', group: 'main', name: 'temp' }
const relay: PointRef = { device: 'conn-1', group: 'main', name: 'relay' }
const notes: PointRef = { device: 'ro-1', group: 'main', name: 'notes' }

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-field-rpc-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  await ctx.plugin(auditPlugin)
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(fieldRpcPlugin)

  let drive!: ConnectionRegistration
  await ctx.plugin(Object.assign(
    function rigDriver(sub: Context): void {
      sub.field.registerDriver(sub, {
        id: 'rig',
        title: 'Rig',
        mappings: () => ({
          devices: [{ id: 'conn-1', driver: 'rig' }, { id: 'ro-1', driver: 'rig' }],
          groups: [{ deviceId: 'conn-1', name: 'main', type: 'float' }],
          points: [{ deviceId: 'conn-1', group: 'main', name: 'temp' }],
        }),
      })
      const writable = sub.connections.register(sub, { id: ConnectionId('conn-1'), driver: 'rig', title: 'Rig' })
      writable.setPoints([
        { ...temp, connection: ConnectionId('conn-1'), type: 'float' },
        { ...relay, connection: ConnectionId('conn-1'), type: 'bool' },
      ])
      writable.setWriteHandler((point, value) => writable.sample(point, value))
      const readOnly = sub.connections.register(sub, { id: ConnectionId('ro-1'), driver: 'rig', title: 'Read only' })
      readOnly.setPoints([
        { ...notes, connection: ConnectionId('ro-1'), type: 'string' },
      ])
      drive = writable
    },
    { inject: ['connections', 'field'] },
  ))

  return {
    ctx,
    client: new InProcessApiClient(request => ctx.rpc.handleClientRequest(request)),
    auditFile: join(home, 'audit.jsonl'),
    drive,
  }
}

describe('field rpc bridge', () => {
  it('serves field.points.list and field.points.read over the full round trip', async () => {
    const world = await makeWorld()
    const { client } = world

    const list = await client.call('field.points.list', {})
    expect(list.ok && list.value.points.map(point => pointKey(point))).toEqual([
      'conn-1/main/temp', 'conn-1/main/relay', 'ro-1/main/notes',
    ])

    const samples = await client.call('field.points.read', { points: [temp] })
    expect(samples.ok).toBe(true)
    // Registered but never sampled reads as the abnormal `null` sample.
    if (samples.ok) expect(samples.value.samples[0]).toEqual({ ...temp, value: null, time: 0 })

    world.drive.sample(temp, 21.5)
    const fresh = await client.call('field.points.read', { points: [temp] })
    expect(fresh.ok && fresh.value.samples[0]?.value).toBe(21.5)

    const missing = await client.call('field.points.read', { points: [{ device: 'ghost', group: 'main', name: 'x' }] })
    expect(missing).toEqual({ ok: false, error: { code: 'not-found', details: { what: 'unknown points: ghost/main/x' } } })
  })

  it('audits an accepted write and echoes it back through the driver handler', async () => {
    const { client, auditFile } = await makeWorld()

    const written = await client.call('field.points.write', { point: relay, value: true })
    expect(written).toEqual({ ok: true, value: { accepted: true } })

    // The rig's write handler echoes; the read observes the fresh sample.
    const read = await client.call('field.points.read', { points: [relay] })
    expect(read.ok && read.value.samples[0]?.value).toBe(true)

    const trail = readFileSync(auditFile, 'utf8')
    expect(trail).toContain('"action":"field.point.write"')
    expect(trail).toContain('"subject":"conn-1/main/relay"')
    expect(trail).toContain('"value":true')
  })

  it('maps field failures to not-found / bad-request / unavailable wire errors', async () => {
    const { client } = await makeWorld()

    const unknown = await client.call('field.points.write', { point: { device: 'ghost', group: 'main', name: 'x' }, value: 1 })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found')

    const mismatch = await client.call('field.points.write', { point: relay, value: 3 })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('bad-request')

    const unwritable = await client.call('field.points.write', { point: notes, value: 'x' })
    expect(unwrappedCode(unwritable)).toBe('unavailable')
  })

  it('serves the driver registry and the aggregated mapping document', async () => {
    const { client, ctx } = await makeWorld()

    const drivers = await client.call('field.drivers.list', {})
    expect(drivers).toEqual({ ok: true, value: { drivers: [{ id: 'rig', title: 'Rig' }] } })

    const mappings = await client.call('field.mappings.list', {})
    expect(mappings.ok && mappings.value.mappings).toEqual({
      devices: [{ id: 'conn-1', driver: 'rig' }, { id: 'ro-1', driver: 'rig' }],
      groups: [{ deviceId: 'conn-1', name: 'main', type: 'float' }],
      points: [{ deviceId: 'conn-1', group: 'main', name: 'temp' }],
    })

    // A driver's change notice rides the internal event out as the wire frame.
    const received: ServerRequest[] = []
    const detach = ctx.rpc.attachDownlink(frame => received.push(frame))
    ctx.field.mappingsChanged()
    expect(received.some(frame => frame.method === 'field/mappings-changed')).toBe(true)
    detach()
  })

  it('filters point frames by subscription and always streams structural frames', async () => {
    const world = await makeWorld()
    const { client } = world
    const received: ServerRequest[] = []
    const detach = world.ctx.rpc.attachDownlink(frame => received.push(frame))

    await client.call('field.points.subscribe', { points: [temp] })
    world.drive.sample(relay, false)
    world.drive.sample(temp, 21.5)
    await new Promise(resolve => setTimeout(resolve, 0))

    const updates = received.filter(frame => frame.method === 'field/point-updated')
    expect(updates.map(frame => pointKey(frame.payload as PointRef))).toEqual(['conn-1/main/temp'])
    expect((updates[0]?.payload as { value: number }).value).toBe(21.5)

    await client.call('field.points.unsubscribe', { points: [temp] })
    world.drive.sample(temp, 22)
    world.drive.setStatus('online')
    await new Promise(resolve => setTimeout(resolve, 0))

    const lateUpdates = received.filter(frame => frame.method === 'field/point-updated').length
    expect(lateUpdates).toBe(1)
    // Status is structural: it flows regardless of point subscriptions.
    expect(received.some(frame =>
      frame.method === 'field/connection-status'
      && (frame.payload as { status: string }).status === 'online',
    )).toBe(true)
    detach()
  })

  it('counts subscription references so one unsubscribe never starves the rest', async () => {
    const world = await makeWorld()
    const { client } = world
    const received: ServerRequest[] = []
    const detach = world.ctx.rpc.attachDownlink(frame => received.push(frame))
    const updates = (): number => received.filter(frame => frame.method === 'field/point-updated').length

    // Two consumers (a value cell and a group LED, say) hold the address.
    await client.call('field.points.subscribe', { points: [temp] })
    await client.call('field.points.subscribe', { points: [temp] })
    world.drive.sample(temp, 21.5)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates()).toBe(1)

    // One unmounts; the other's frames must keep flowing.
    await client.call('field.points.unsubscribe', { points: [temp] })
    world.drive.sample(temp, 22)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates()).toBe(2)

    // The last reference out stops the frames.
    await client.call('field.points.unsubscribe', { points: [temp] })
    world.drive.sample(temp, 23)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates()).toBe(2)

    // Over-unsubscribing is a harmless clamp at zero, never a negative count.
    const excess = await client.call('field.points.unsubscribe', { points: [temp] })
    expect(excess.ok).toBe(true)
    world.drive.sample(temp, 24)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates()).toBe(2)
    detach()
  })
})

function unwrappedCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code
}
