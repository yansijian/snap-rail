import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import fieldPlugin from '@snap-rail/field'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '../../../store/store/src/index.ts'
import { InProcessApiClient, type ModbusDeviceConfig } from '@snap-rail/protocol'
import modbusSerial from 'modbus-serial'
import { afterEach, describe, expect, it } from 'vitest'
import driverPlugin from '../src/index.ts'
import modbusRpcPlugin from '../src/rpc.ts'

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
  await ctx.plugin(timerPlugin)
  await ctx.plugin(driverPlugin)
  await ctx.plugin(modbusRpcPlugin)
  return { ctx, client: new InProcessApiClient(request => ctx.gateway.handleClientRequest(request)) }
}

function device(overrides: Partial<ModbusDeviceConfig>): ModbusDeviceConfig {
  return { id: 'plc1', title: '1号炉', host: '127.0.0.1', port: 502, unitId: 1, pollMs: 200, timeoutMs: 300, enabled: true, ...overrides }
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

    const empty = await client.call('modbus.devices.list', {})
    expect(empty).toEqual({ ok: true, value: { devices: [], points: [], vars: [] } })

    const invalid = await client.call('modbus.devices.upsert', { device: device({ port: 0 }) })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('bad-request')

    const mixed = await client.call('modbus.points.upsert', { point: {
      var: '温度1', deviceId: 'plc1', type: 'float', fc: 3, address: 100,
      encoding: 'coil', byteOrder: 'abcd', writable: false,
    } })
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.error.code).toBe('bad-request')

    const saved = await client.call('modbus.devices.upsert', { device: device({}) })
    expect(saved).toEqual({ ok: true, value: { applied: true } })

    const doc = await client.call('modbus.devices.list', {})
    expect(doc.ok && doc.value.devices[0]).toMatchObject({ id: 'plc1', host: '127.0.0.1', port: 502 })
  })

  it('validates references and cascades removals', async () => {
    const { client } = await makeWorld()
    await client.call('modbus.devices.upsert', { device: device({}) })

    const orphan = await client.call('modbus.points.upsert', { point: {
      var: '温度1', deviceId: 'ghost', type: 'float', fc: 3, address: 100,
      encoding: 'f32', byteOrder: 'abcd', writable: false,
    } })
    expect(orphan.ok).toBe(false)
    if (!orphan.ok) expect(orphan.error.code).toBe('not-found')

    const manual = await client.call('modbus.vars.upsert', { name: '调试A', type: 'int' })
    expect(manual).toEqual({ ok: true, value: { applied: true } })
    const mapped = await client.call('modbus.points.upsert', { point: {
      var: '调试A', deviceId: 'plc1', type: 'int', fc: 3, address: 200,
      encoding: 'i16', byteOrder: 'abcd', writable: true,
    } })
    expect(mapped).toEqual({ ok: true, value: { applied: true } })

    // Removing the var takes its mapping with it.
    await client.call('modbus.vars.remove', { name: '调试A' })
    const after = await client.call('modbus.devices.list', {})
    expect(after.ok && after.value.points).toEqual([])

    // Removing the device cascades and a second remove fails not-found.
    await client.call('modbus.devices.remove', { id: 'plc1' })
    const empty = await client.call('modbus.devices.list', {})
    expect(empty).toEqual({ ok: true, value: { devices: [], points: [], vars: [] } })
    const again = await client.call('modbus.devices.remove', { id: 'plc1' })
    expect(again.ok).toBe(false)
  })

  it('hot-applies per device: untouched devices keep their connection', async () => {
    const { ctx, client } = await makeWorld()
    const portA = await makePlc()
    const portB = await makePlc()
    await client.call('modbus.devices.upsert', { device: device({ id: 'plcA', port: portA }) })
    await client.call('modbus.devices.upsert', { device: device({ id: 'plcB', port: portB }) })
    await client.call('modbus.points.upsert', { point: {
      var: '温度1', deviceId: 'plcA', type: 'float', fc: 3, address: 100,
      encoding: 'f32', byteOrder: 'abcd', writable: false,
    } })
    await waitFor(() => ctx.connections.list().filter(c => c.status === 'online').length === 2, 'both online')

    const statuses: Array<{ id: string, status: string }> = []
    ctx.connections.subscribeStatus(frame => statuses.push({ id: frame.id, status: frame.status }))
    const onlineBefore = statuses.filter(entry => entry.id === 'plcA' && entry.status === 'online').length

    // Mutate plcB only: plcA must not flicker.
    await client.call('modbus.devices.upsert', { device: device({ id: 'plcB', port: portB, pollMs: 300 }) })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(statuses.filter(entry => entry.id === 'plcA' && entry.status === 'offline')).toHaveLength(0)
    expect(statuses.filter(entry => entry.id === 'plcA' && entry.status === 'online').length).toBeGreaterThanOrEqual(onlineBefore)

    // Removing B drops exactly B's connection.
    await client.call('modbus.devices.remove', { id: 'plcB' })
    await waitFor(() => !ctx.connections.list().some(c => c.id === 'plcB'), 'plcB gone')
    expect(ctx.connections.list().map(c => c.id)).toEqual(['plcA'])
  }, 20_000)
})
