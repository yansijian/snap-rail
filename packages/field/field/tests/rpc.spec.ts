import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import {
  ConnectionId,
  InProcessApiClient,
  PointId,
  type ServerRequest,
} from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import gatewayPlugin from '@snap-rail/gateway'
import fieldPlugin, { type ConnectionRegistration } from '../src/index.ts'
import fieldRpcPlugin from '../src/rpc.ts'

const worlds: Array<{ ctx: Context; home: string }> = []

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
      const writable = sub.connections.register(sub, { id: ConnectionId('conn-1'), driver: 'rig', title: 'Rig' })
      writable.setPoints([
        { id: PointId('conn-1.temp'), connection: ConnectionId('conn-1'), type: 'float' },
        { id: PointId('conn-1.relay'), connection: ConnectionId('conn-1'), type: 'bool' },
      ])
      writable.setWriteHandler((point, value) => writable.sample(point.id, value))
      const readOnly = sub.connections.register(sub, { id: ConnectionId('ro-1'), driver: 'rig', title: 'Read only' })
      readOnly.setPoints([
        { id: PointId('ro-1.notes'), connection: ConnectionId('ro-1'), type: 'string' },
      ])
      drive = writable
    },
    { inject: ["connections"] },
  ))

  return {
    ctx,
    client: new InProcessApiClient(request => ctx.gateway.handleClientRequest(request)),
    auditFile: join(home, 'audit.jsonl'),
    drive,
  }
}

describe('field rpc bridge', () => {
  it('serves points.list and points.read over the full round trip', async () => {
    const world = await makeWorld()
    const { client } = world

    const list = await client.call('points.list', {})
    expect(list.ok && list.value.points.map(point => point.id)).toEqual([
      'conn-1.temp', 'conn-1.relay', 'ro-1.notes',
    ])

    const samples = await client.call('points.read', { ids: ['conn-1.temp'] })
    expect(samples.ok).toBe(true)
    // Registered but never sampled reads as the abnormal `null` sample.
    if (samples.ok) expect(samples.value.samples[0]).toEqual({ id: 'conn-1.temp', value: null, time: 0 })

    world.drive.sample(PointId('conn-1.temp'), 21.5)
    const fresh = await client.call('points.read', { ids: ['conn-1.temp'] })
    expect(fresh.ok && fresh.value.samples[0]?.value).toBe(21.5)

    const missing = await client.call('points.read', { ids: ['ghost'] })
    expect(missing).toEqual({ ok: false, error: { code: 'not-found', details: { what: 'unknown points: ghost' } } })
  })

  it('audits an accepted write and echoes it back through the driver handler', async () => {
    const { client, auditFile } = await makeWorld()

    const written = await client.call('points.write', { id: 'conn-1.relay', value: true })
    expect(written).toEqual({ ok: true, value: { accepted: true } })

    // The rig's write handler echoes; the read observes the fresh sample.
    const read = await client.call('points.read', { ids: ['conn-1.relay'] })
    expect(read.ok && read.value.samples[0]?.value).toBe(true)

    const trail = readFileSync(auditFile, 'utf8')
    expect(trail).toContain('"action":"point.write"')
    expect(trail).toContain('"subject":"conn-1.relay"')
    expect(trail).toContain('"value":true')
  })

  it('maps field failures to not-found / bad-request / unavailable wire errors', async () => {
    const { client } = await makeWorld()

    const unknown = await client.call('points.write', { id: 'ghost', value: 1 })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found')

    const mismatch = await client.call('points.write', { id: 'conn-1.relay', value: 3 })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('bad-request')

    const unwritable = await client.call('points.write', { id: 'ro-1.notes', value: 'x' })
    expect(unwrappedCode(unwritable)).toBe('unavailable')
  })

  it('filters point frames by subscription and always streams structural frames', async () => {
    const world = await makeWorld()
    const { client } = world
    const received: ServerRequest[] = []
    const detach = world.ctx.gateway.attachDownlink(frame => received.push(frame))

    await client.call('points.subscribe', { ids: ['conn-1.temp'] })
    world.drive.sample(PointId('conn-1.relay'), false)
    world.drive.sample(PointId('conn-1.temp'), 21.5)
    await new Promise(resolve => setTimeout(resolve, 0))

    const updates = received.filter(frame => frame.method === 'point/updated')
    expect(updates.map(frame => (frame.payload as { id: string }).id)).toEqual(['conn-1.temp'])
    expect((updates[0]?.payload as { value: number }).value).toBe(21.5)

    await client.call('points.unsubscribe', { ids: ['conn-1.temp'] })
    world.drive.sample(PointId('conn-1.temp'), 22)
    world.drive.setStatus('online')
    await new Promise(resolve => setTimeout(resolve, 0))

    const lateUpdates = received.filter(frame => frame.method === 'point/updated').length
    expect(lateUpdates).toBe(1)
    // Status is structural: it flows regardless of point subscriptions.
    expect(received.some(frame =>
      frame.method === 'connection/status'
      && (frame.payload as { status: string }).status === 'online',
    )).toBe(true)
    detach()
  })
})

function unwrappedCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code
}
