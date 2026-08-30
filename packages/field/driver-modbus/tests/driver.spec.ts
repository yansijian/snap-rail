import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import fieldPlugin, { type ConnectionRegistration } from '@snap-rail/field'
import { pointKey, type ConnectionSnapshot, type PointRef, type PointSample } from '@snap-rail/field'
import modbusSerial, { type ServerTCP as ServerTCPType } from 'modbus-serial'
import { afterEach, describe, expect, it } from 'vitest'
import driverPlugin from '../src/index.ts'
import { MODBUS_TABLES } from '../src/tables.ts'
import storePlugin from '../../../store/store/src/index.ts'

const { ServerTCP } = modbusSerial as unknown as { ServerTCP: new (vector: Record<string, unknown>, options: { host?: string, port?: number, unitID?: number }) => ServerTCPType }

const worlds: Array<{ ctx: Context, home: string }> = []
const servers: ServerTCP[] = []

afterEach(async () => {
  // Close the fake PLCs first: an in-flight poll then fails into its own
  // catch while the host tree is still wired, instead of racing a socket
  // read against teardown (an unhandled ECONNRESET otherwise leaks).
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
  await new Promise(resolve => setTimeout(resolve, 25))
})

/** An in-process PLC: holding registers and coils addressed by number. */
interface FakePlc {
  port: number
  holding: Map<number, number>
  coils: Map<number, boolean>
  start(): Promise<void>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

async function makePlc(): Promise<FakePlc> {
  const holding = new Map<number, number>()
  const coils = new Map<number, boolean>()
  const port = await freePort()
  let server: ServerTCP | undefined
  const vector = {
    getHoldingRegister: (addr: number): number => holding.get(addr) ?? 0,
    getCoil: (addr: number): boolean => coils.get(addr) ?? false,
    setCoil: (addr: number, value: boolean): void => { coils.set(addr, value) },
  }
  return {
    port,
    holding,
    coils,
    async start(): Promise<void> {
      server = new ServerTCP(vector, { host: '127.0.0.1', port, unitID: 1 })
      await new Promise<void>(resolve => server!.on('initialized', resolve))
      servers.push(server)
    },
    async stop(): Promise<void> {
      await new Promise<void>(resolve => server?.close(() => resolve()))
      server = undefined
    },
  }
}

function floatRegs(value: number): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  return [view.getUint16(0), view.getUint16(2)]
}

interface World {
  ctx: Context
  plc: FakePlc
  store: import('@snap-rail/store').StoreHandle
  samples: PointSample[]
  statuses: ConnectionSnapshot[]
}

const tempRef: PointRef = { device: 'plc1', group: '温度', name: '温度1' }
const countRef: PointRef = { device: 'plc1', group: '计数', name: '计数1' }
const switchRef: PointRef = { device: 'plc1', group: '开关', name: '开关1' }

async function makeWorld(plc: FakePlc): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-driver-modbus-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  // The root entry also mounts the rpc bridge, so its whole inject face
  // (gateway/settings/audit included) must be up before it starts.
  await ctx.plugin(gatewayPlugin, { name: 'driver-spec', version: '0.0.0', bin: 'test' })
  await ctx.plugin(settingsPlugin)
  await ctx.plugin(auditPlugin)
  await ctx.plugin(storePlugin)
  await ctx.plugin(fieldPlugin)
  await ctx.plugin(timerPlugin)
  await ctx.plugin(driverPlugin)
  const store = ctx.store.register(ctx, 'driver_modbus', MODBUS_TABLES)
  const samples: PointSample[] = []
  const statuses: ConnectionSnapshot[] = []
  ctx.points.subscribe([tempRef, countRef, switchRef], sample => samples.push(sample))
  ctx.connections.subscribeStatus(frame => statuses.push({ id: frame.id, status: frame.status, time: frame.time, driver: 'driver-modbus', title: frame.id }))
  return { ctx, plc, store, samples, statuses }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One enabled device with three mapped variables on the fake PLC. */
function seedDevice(store: World['store'], port: number): void {
  store.run(
    `INSERT INTO ${store.table('devices')} (id, title, host, port, unit_id, poll_ms, timeout_ms, enabled) `
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['plc1', '1号炉', '127.0.0.1', port, 1, 60, 250, 1],
  )
  const groups = store.table('groups')
  store.run(`INSERT INTO ${groups} (device_id, name, type) VALUES (?, ?, ?)`, ['plc1', '温度', 'float'])
  store.run(`INSERT INTO ${groups} (device_id, name, type) VALUES (?, ?, ?)`, ['plc1', '计数', 'int'])
  store.run(`INSERT INTO ${groups} (device_id, name, type) VALUES (?, ?, ?)`, ['plc1', '开关', 'bool'])
  const points = store.table('points')
  store.run(`INSERT INTO ${points} (var, device_id, type, fc, address, encoding, scale, writable, deadband, group_name) `
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['温度1', 'plc1', 'float', 3, 100, 'f32', 0.1, 0, null, '温度'])
  store.run(`INSERT INTO ${points} (var, device_id, type, fc, address, encoding, scale, writable, deadband, group_name) `
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['计数1', 'plc1', 'int', 3, 104, 'u32', null, 0, null, '计数'])
  store.run(`INSERT INTO ${points} (var, device_id, type, fc, address, encoding, scale, writable, deadband, group_name) `
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['开关1', 'plc1', 'bool', 1, 10, 'coil', null, 1, null, '开关'])
}

function latestSample(samples: PointSample[], ref: PointRef): PointSample | undefined {
  return [...samples].reverse().find(sample => pointKey(sample) === pointKey(ref))
}

describe('driver-modbus over a fake PLC', () => {
  it('polls, decodes, and reports the first observation once online', async () => {
    const plc = await makePlc()
    plc.holding.set(100, floatRegs(100)[0] as number) // f32 raw 100.0 → scale 0.1 → 10
    plc.holding.set(101, floatRegs(100)[1] as number)
    plc.holding.set(104, 0)
    plc.holding.set(105, 7) // u32 = 7
    await plc.start()

    const world = await makeWorld(plc)
    seedDevice(world.store, plc.port)
    world.ctx.emit('modbus/config-changed')

    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')
    const temperature = latestSample(world.samples, tempRef)
    expect(temperature?.value).toBeCloseTo(10)
    expect(latestSample(world.samples, countRef)?.value).toBe(7n)
    expect(latestSample(world.samples, switchRef)?.value).toBe(false)
  }, 15_000)

  it('reports only on change', async () => {
    const plc = await makePlc()
    plc.holding.set(105, 7)
    await plc.start()

    const world = await makeWorld(plc)
    seedDevice(world.store, plc.port)
    world.ctx.emit('modbus/config-changed')
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
    const plc = await makePlc()
    await plc.start()

    const world = await makeWorld(plc)
    seedDevice(world.store, plc.port)
    world.ctx.emit('modbus/config-changed')
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')

    await world.ctx.points.write(switchRef, true)
    await waitFor(() => plc.coils.get(10) === true, 'coil state on the wire')
    await waitFor(() => latestSample(world.samples, switchRef)?.value === true, 'echo sample')
  }, 15_000)

  it('goes offline with one null round and recovers when the PLC returns', async () => {
    const plc = await makePlc()
    plc.holding.set(105, 7)
    await plc.start()

    const world = await makeWorld(plc)
    seedDevice(world.store, plc.port)
    world.ctx.emit('modbus/config-changed')
    await waitFor(() => world.statuses.some(frame => frame.id === 'plc1' && frame.status === 'online'), 'online')

    await plc.stop()
    await waitFor(() => world.statuses.at(-1)?.status === 'offline', 'offline')
    expect(latestSample(world.samples, countRef)?.value).toBeNull()

    // Quiet while down: exactly one null round per point.
    const nulls = world.samples.filter(sample => sample.value === null).length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(world.samples.filter(sample => sample.value === null).length).toBe(nulls)

    await plc.start()
    await waitFor(() => world.statuses.at(-1)?.status === 'online', 'recovered')
    // null → value is a change: values re-report without being re-seeded.
    await waitFor(() => latestSample(world.samples, countRef)?.value === 7n, 'value re-reported')
  }, 20_000)
})

/** Keep the type import honest: the driver owns its registrations. */
export type { ConnectionRegistration }
