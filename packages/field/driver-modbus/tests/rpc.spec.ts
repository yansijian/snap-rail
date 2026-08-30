import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import fieldPlugin from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '../../../store/store/src/index.ts'
import { InProcessApiClient } from '@snap-rail/protocol'
import type { ModbusDeviceConfig } from '@snap-rail/driver-modbus/contract'
import modbusSerial from 'modbus-serial'
import { afterEach, describe, expect, it } from 'vitest'
import driverPlugin from '../src/index.ts'

const { ServerTCP } = modbusSerial

const worlds: Array<{ ctx: Context, home: string }> = []
const servers: ServerTCP[] = []

afterEach(async () => {
  // Servers close before the host tree so in-flight reads land in the
  // driver's catch instead of racing teardown.
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
  await new Promise(resolve => setTimeout(resolve, 25))
})

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

async function makePlc(): Promise<number> {
  const port = await freePort()
  const server = new ServerTCP({ getHoldingRegister: () => 0 }, { host: '127.0.0.1', port, unitID: 1 })
  await new Promise<void>(resolve => server.on('initialized', resolve))
  servers.push(server)
  return port
}

async function makeWorld(): Promise<{ ctx: Context, client: InProcessApiClient }> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-modbus-rpc-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(gatewayPlugin, { name: 'test', version: '0.0.0', bin: 'test' })
  await ctx.plugin(settingsPlugin)
  await ctx.plugin(auditPlugin)
  await ctx.plugin(storePlugin)
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(fieldRpcPlugin)
  await ctx.plugin(timerPlugin)
  // The root entry mounts the bridge too; mounting it again here would
  // double-claim the field.modbus domain.
  await ctx.plugin(driverPlugin)
  return { ctx, client: new InProcessApiClient(request => ctx.rpc.handleClientRequest(request)) }
}

function device(overrides: Partial<ModbusDeviceConfig>): ModbusDeviceConfig {
  return {
    id: 'plc1', title: '1号炉', host: '127.0.0.1', port: 502, unitId: 1, pollMs: 200, timeoutMs: 300,
    byteOrder: 'abcd', enabled: true, ...overrides,
  }
}

function point(overrides: Partial<Record<string, unknown>> & { var: string }): Record<string, unknown> {
  return {
    deviceId: 'plc1', type: 'bool', fc: 1, address: 0, encoding: 'coil',
    writable: false, group: '故障报警', ...overrides,
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('modbus bridge', () => {
  it('round-trips the document and rejects malformed payloads at the boundary', async () => {
    const { client } = await makeWorld()

    const empty = await client.call('field.modbus.devices.list', {})
    expect(empty).toEqual({ ok: true, value: { devices: [], groups: [], points: [] } })

    const invalid = await client.call('field.modbus.devices.upsert', { device: device({ port: 0 }) })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('bad-request')

    const mixed = await client.call('field.modbus.points.upsert',
      { point: point({ var: '温度1', type: 'float', fc: 3, address: 100, encoding: 'coil' }) })
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.error.code).toBe('bad-request')

    const saved = await client.call('field.modbus.devices.upsert', { device: device({}) })
    expect(saved).toEqual({ ok: true, value: { applied: true } })

    const doc = await client.call('field.modbus.devices.list', {})
    expect(doc.ok && doc.value.devices[0]).toMatchObject({ id: 'plc1', host: '127.0.0.1', port: 502 })
  })

  it('round-trips the device word order', async () => {
    const { client } = await makeWorld()
    await client.call('field.modbus.devices.upsert', { device: device({ byteOrder: 'cdab' }) })
    const doc = await client.call('field.modbus.devices.list', {})
    expect(doc.ok && doc.value.devices[0]?.byteOrder).toBe('cdab')
  })

  it('validates references and cascades removals', async () => {
    const { client } = await makeWorld()
    await client.call('field.modbus.devices.upsert', { device: device({}) })
    const group = await client.call('field.modbus.groups.upsert', { group: { deviceId: 'plc1', name: '调试', type: 'int' } })
    expect(group).toEqual({ ok: true, value: { applied: true } })

    const orphan = await client.call('field.modbus.points.upsert',
      { point: point({ var: '温度1', deviceId: 'ghost', group: '调试', type: 'int', fc: 3, address: 100, encoding: 'i16' }) })
    expect(orphan.ok).toBe(false)
    if (!orphan.ok) expect(orphan.error.code).toBe('not-found')

    // A point whose group does not exist on its device is refused too.
    const noGroup = await client.call('field.modbus.points.upsert',
      { point: point({ var: '温度1', group: '不存在', type: 'int', fc: 3, address: 100, encoding: 'i16' }) })
    expect(noGroup.ok).toBe(false)
    if (!noGroup.ok) expect(noGroup.error.code).toBe('not-found')

    const saved = await client.call('field.modbus.points.upsert',
      { point: point({ var: '温度1', group: '调试', type: 'int', fc: 3, address: 200, encoding: 'i16', writable: true }) })
    expect(saved).toEqual({ ok: true, value: { applied: true } })

    // Removing by the identity triple works; a wrong group misses.
    const removed = await client.call('field.modbus.points.remove',
      { deviceId: 'plc1', group: '调试', name: '温度1' })
    expect(removed).toEqual({ ok: true, value: { applied: true } })
    const missed = await client.call('field.modbus.points.remove',
      { deviceId: 'plc1', group: '故障报警', name: '温度1' })
    expect(missed.ok).toBe(false)
    if (!missed.ok) expect(missed.error.code).toBe('not-found')

    // Removing the device cascades (groups included) and a second remove fails.
    await client.call('field.modbus.devices.remove', { id: 'plc1' })
    const empty = await client.call('field.modbus.devices.list', {})
    expect(empty).toEqual({ ok: true, value: { devices: [], groups: [], points: [] } })
    const again = await client.call('field.modbus.devices.remove', { id: 'plc1' })
    expect(again.ok).toBe(false)
  })

  it('enforces the typed-group rule and the per-group name uniqueness', async () => {
    const { ctx, client } = await makeWorld()
    await client.call('field.modbus.devices.upsert', { device: device({}) })

    // The frame renderer watchers re-resolve on; the host event only feeds
    // the driver itself.
    const frames: string[] = []
    ctx.rpc.attachDownlink(frame => {
      if (frame.method === 'field/modbus-config-changed') frames.push(frame.method)
    })

    // Groups exist ahead of their points, trims apply, and the group reads
    // back as its own entity.
    const created = await client.call('field.modbus.groups.upsert',
      { group: { deviceId: 'plc1', name: ' 故障报警 ', type: 'bool' } })
    expect(created).toEqual({ ok: true, value: { applied: true } })
    const saved = await client.call('field.modbus.points.upsert',
      { point: point({ var: '主轴过载', address: 10, group: '故障报警' }) })
    expect(saved).toEqual({ ok: true, value: { applied: true } })
    const doc = await client.call('field.modbus.devices.list', {})
    expect(doc.ok && doc.value.groups[0]).toMatchObject({ deviceId: 'plc1', name: '故障报警', type: 'bool' })
    expect(doc.ok && doc.value.points[0]?.group).toBe('故障报警')

    // The same name in another group is a different point (group-scoped
    // uniqueness); same name same group replaces.
    const other = await client.call('field.modbus.groups.upsert', { group: { deviceId: 'plc1', name: '备用', type: 'bool' } })
    expect(other.ok).toBe(true)
    const again = await client.call('field.modbus.points.upsert',
      { point: point({ var: '主轴过载', address: 30, group: '备用' }) })
    expect(again).toEqual({ ok: true, value: { applied: true } })
    const both = await client.call('field.modbus.devices.list', {})
    expect(both.ok && both.value.points).toHaveLength(2)

    // The group's type rules its members: a float point is a conflict.
    const mismatch = await client.call('field.modbus.points.upsert',
      { point: point({ var: '炉温', type: 'float', fc: 3, address: 0, encoding: 'f32' }) })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('conflict')

    // Retyping a group that still holds points is refused; an empty one is not.
    const retype = await client.call('field.modbus.groups.upsert',
      { group: { deviceId: 'plc1', name: '故障报警', type: 'int' } })
    expect(retype.ok).toBe(false)
    if (!retype.ok) expect(retype.error.code).toBe('conflict')
    const spare = await client.call('field.modbus.groups.upsert', { group: { deviceId: 'plc1', name: '空闲', type: 'int' } })
    expect(spare.ok).toBe(true)

    // Names reject the qualified-id separator.
    const slashed = await client.call('field.modbus.points.upsert',
      { point: point({ var: 'a/b' }) })
    expect(slashed.ok).toBe(false)
    if (!slashed.ok) expect(slashed.error.code).toBe('bad-request')

    // Removing the group takes its points; a second remove fails not-found.
    await client.call('field.modbus.groups.remove', { deviceId: 'plc1', name: '故障报警' })
    const after = await client.call('field.modbus.devices.list', {})
    expect(after.ok && after.value.points.map(entry => `${entry.group}/${entry.var}`)).toEqual(['备用/主轴过载'])
    const onceMore = await client.call('field.modbus.groups.remove', { deviceId: 'plc1', name: '故障报警' })
    expect(onceMore.ok).toBe(false)
    if (!onceMore.ok) expect(onceMore.error.code).toBe('not-found')

    // Every successful mutation above broadcast the config-change frame
    // (failures never reach the notify step).
    expect(frames).toHaveLength(6)
  })

  it('hot-applies per device: untouched devices keep their connection', async () => {
    const { ctx, client } = await makeWorld()
    const portA = await makePlc()
    const portB = await makePlc()
    await client.call('field.modbus.devices.upsert', { device: device({ id: 'plcA', port: portA }) })
    await client.call('field.modbus.devices.upsert', { device: device({ id: 'plcB', port: portB }) })
    await client.call('field.modbus.groups.upsert', { group: { deviceId: 'plcA', name: '温度', type: 'float' } })
    await client.call('field.modbus.points.upsert', {
      point: {
        var: '温度1', deviceId: 'plcA', type: 'float', fc: 3, address: 100,
        encoding: 'f32', writable: false, group: '温度',
      },
    })
    await waitFor(() => ctx.connections.list().filter(c => c.status === 'online').length === 2, 'both online')

    const statuses: Array<{ id: string, status: string }> = []
    ctx.connections.subscribeStatus(frame => statuses.push({ id: frame.id, status: frame.status }))
    const onlineBefore = statuses.filter(entry => entry.id === 'plcA' && entry.status === 'online').length

    // Mutate plcB only: plcA must not flicker.
    await client.call('field.modbus.devices.upsert', { device: device({ id: 'plcB', port: portB, pollMs: 300 }) })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(statuses.filter(entry => entry.id === 'plcA' && entry.status === 'offline')).toHaveLength(0)
    expect(statuses.filter(entry => entry.id === 'plcA' && entry.status === 'online').length).toBeGreaterThanOrEqual(onlineBefore)

    // Removing B drops exactly B's connection.
    await client.call('field.modbus.devices.remove', { id: 'plcB' })
    await waitFor(() => !ctx.connections.list().some(c => c.id === 'plcB'), 'plcB gone')
    expect(ctx.connections.list().map(c => c.id)).toEqual(['plcA'])
  }, 20_000)
})
