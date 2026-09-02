/**
 * The ModbusTCP field driver: a pure protocol adapter over the field base.
 * The base owns the device/group/point tables and calls `createConnection`
 * per configured device; this runtime runs one serial I/O queue per device,
 * merges mapped addresses into as few block reads as possible, and samples
 * only on change (first read always reports; float deadband per point).
 * Failures drop the link to offline with one `null` sample per point and
 * retry every poll tick. Writes ride the base's write handler (fc 5/6/16)
 * and echo back as samples.
 *
 * Update policy (the driver decides, the base orchestrates): host/port/
 * unitId/timeoutMs/byteOrder changes drop the socket and reconnect on the
 * next poll; point-table changes re-plan in place; pollMs changes retime
 * the interval; `enabled: false` parks the device (no polling, offline).
 *
 * @module @snap-rail/driver-modbus
 */

import ModbusRTU from 'modbus-serial'
import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the driver-registration
// declaration merging alongside the runtime service.
import '@snap-rail/field'
import {
  FieldError,
  pointKey,
  type DriverConnection,
  type DriverDevice,
  type DriverHandle,
  type DriverPoint,
  type PointRef,
  type PointValue,
} from '@snap-rail/field'
import {
  modbusDeviceSchema,
  modbusPointSchema,
  type ModbusDeviceConfig,
  type ModbusPointConfig,
} from './contract.ts'
import { decodePoint, encodeWrite, planPoll, type BlockPayload, type PlannedPoint, type PollBlock } from './plc.ts'
import { probeDevice } from './probe.ts'

export { probeDevice } from './probe.ts'
export { modbusDeviceSchema, modbusPointSchema } from './contract.ts'
export type { ModbusDeviceConfig, ModbusPointConfig } from './contract.ts'

/** Dialect plus field address — the poll plan's shape for one point. */
const plannedOf = (point: DriverPoint): PlannedPoint => ({
  ...(modbusPointSchema.parse({ type: point.type, ...point.config }) as ModbusPointConfig),
  ref: { device: point.device, group: point.group, name: point.name },
})

/** One mapped point as the runtime addresses it: the triple plus its dialect. */
interface MappedPoint {
  ref: PointRef
  dialect: ModbusPointConfig
}

interface DeviceRuntime {
  device: ModbusDeviceConfig
  handle: DriverHandle
  /** Points keyed by the composite point key (`device/group/name`). */
  points: Map<string, MappedPoint>
  plan: PollBlock[]
  /** Last value reported per composite key; drives change detection. */
  last: Map<string, PointValue>
  /** Whether the current abnormal state already pushed one `null` round. */
  nulled: boolean
  online: boolean
  parked: boolean
  client: ModbusRTU
  connectPromise: Promise<void> | undefined
  queueTail: Promise<void>
  stopInterval: () => void
}

/** Parse the base's stored dialect config back into the typed point. */
function mapPoint(point: DriverPoint): MappedPoint {
  const dialect = modbusPointSchema.parse({ type: point.type, ...point.config })
  return {
    ref: { device: point.device, group: point.group, name: point.name },
    dialect,
  }
}

/** Serialize one job behind the device's tail; the returned promise settles
 * with the job's outcome (a write awaits its turn and reports its failure),
 * while the tail itself recovers so later jobs still run. */
const enqueue = (runtime: DeviceRuntime, job: () => Promise<void>): Promise<void> => {
  const run = runtime.queueTail.then(job)
  runtime.queueTail = run.catch(() => {
    // Poll jobs already mark the device abnormal; a write outcome returns to
    // its caller. The tail stays healthy either way.
  })
  return run
}

/** Ports already carrying the write guard (one guard per port instance). */
const guardedPorts = new WeakSet<object>()

/**
 * modbus-serial's TcpPort.write routes a synchronous throw — a write
 * attempted after the socket died — into a promise chain nothing upstream
 * ever handles (their dropped `.finally`), which surfaces as an unhandled
 * process rejection. Swallow the throw at the port: the abandoned request
 * then fails through its own timeout path. Each reconnect builds a fresh
 * port, so the guard re-applies per connection.
 */
const guardPort = (client: ModbusRTU): void => {
  const port = (client as unknown as { _port?: object })._port
  if (port === undefined || guardedPorts.has(port)) return
  guardedPorts.add(port)
  const write = (port as { write(data: never): void }).write.bind(port)
  ;(port as { write(data: never): void }).write = (data: never): void => {
    try {
      write(data)
    } catch {
      // The dead socket answers through the request timeout instead.
    }
  }
}

const ensureConnected = async (runtime: DeviceRuntime): Promise<void> => {
  if (runtime.client.isOpen) return
  runtime.connectPromise ??= (async () => {
    const { host, port, unitId, timeoutMs } = runtime.device
    // connectTCP resolves on an established socket and rejects on failure;
    // its (undefined) resolution value carries no success flag.
    await runtime.client.connectTCP(host, { port })
    runtime.client.setID(unitId)
    runtime.client.setTimeout(timeoutMs)
    guardPort(runtime.client)
  })().finally(() => { runtime.connectPromise = undefined })
  await runtime.connectPromise
}

const readBlock = async (client: ModbusRTU, block: PollBlock): Promise<BlockPayload> => {
  switch (block.fc) {
    case 1: return { bits: (await client.readCoils(block.start, block.count)).data }
    case 2: return { bits: (await client.readDiscreteInputs(block.start, block.count)).data }
    case 3: return { registers: (await client.readHoldingRegisters(block.start, block.count)).data }
    case 4: return { registers: (await client.readInputRegisters(block.start, block.count)).data }
  }
}

/** One abnormal cycle: offline, one `null` per point, forget last values. */
const markAbnormal = (runtime: DeviceRuntime, message?: string): void => {
  runtime.online = false
  runtime.handle.status('offline', message)
  // Drop the socket so the next poll reconnects from scratch; a half-open
  // TCP connection would otherwise never recover.
  try {
    if (runtime.client.isOpen) runtime.client.close(() => {})
  } catch {
    // The socket may already be gone.
  }
  if (runtime.nulled) return
  runtime.nulled = true
  runtime.last.clear()
  for (const point of runtime.points.values()) {
    runtime.handle.sample(point.ref, null)
  }
}

/** Whether the fresh value is worth a frame (change-only reporting). */
const shouldReport = (runtime: DeviceRuntime, key: string, value: PointValue): boolean => {
  const previous = runtime.last.get(key)
  if (previous === undefined || value === null) return true
  if (typeof value === 'number' && typeof previous === 'number') {
    const deadband = runtime.points.get(key)?.dialect.deadband ?? 0
    return Math.abs(value - previous) > deadband
  }
  return value !== previous
}

const pollDevice = async (runtime: DeviceRuntime): Promise<void> => {
  if (runtime.parked) return
  try {
    await ensureConnected(runtime)
      for (const block of runtime.plan) {
      const payload = await readBlock(runtime.client, block)
      for (const { point, offset } of block.entries) {
        const value = decodePoint(point, payload, offset, runtime.device.byteOrder)
        const key = pointKey(point.ref)
        if (!shouldReport(runtime, key, value)) continue
        runtime.last.set(key, value)
        runtime.handle.sample(point.ref, value)
      }
    }
    if (!runtime.online) {
      runtime.online = true
      runtime.handle.status('online')
    }
    runtime.nulled = false
  } catch (cause) {
    markAbnormal(runtime, cause instanceof Error ? cause.message : String(cause))
  }
}

const writePoint = async (runtime: DeviceRuntime, key: string, value: Exclude<PointValue, null>): Promise<void> => {
  const point = runtime.points.get(key)
  if (point === undefined || !point.dialect.writable) {
    throw new FieldError('no-write-handler', `point ${key} is not writable`)
  }
  await ensureConnected(runtime)
  const encoded = encodeWrite(point.dialect, value, runtime.device.byteOrder)
  if (encoded.coil !== undefined) {
    await runtime.client.writeCoil(point.dialect.address, encoded.coil)
  } else if (encoded.registers !== undefined && encoded.registers.length === 1) {
    await runtime.client.writeRegister(point.dialect.address, encoded.registers[0] as number)
  } else if (encoded.registers !== undefined) {
    await runtime.client.writeRegisters(point.dialect.address, encoded.registers)
  }
  // Echo the write as the fresh sample; the next poll compares against it.
  runtime.last.set(key, value)
  runtime.handle.sample(point.ref, value)
}

const closeClient = (runtime: DeviceRuntime): void => {
  try {
    // The callback flavor of close() never mints a promise; without one, the
    // promise API rejects on a dead socket (ECONNRESET) and nobody would be
    // there to handle it.
    if (runtime.client.isOpen) runtime.client.close(() => {})
  } catch {
    // A half-open socket may refuse close; the OS reclaims it.
  }
}

/** Build the per-device runtime: the connection controller this driver owns. */
const createRuntime = (ctx: Context, device: DriverDevice, points: readonly DriverPoint[], handle: DriverHandle): DriverConnection => {
  const runtime: DeviceRuntime = {
    device: modbusDeviceSchema.parse(device.config),
    handle,
    points: new Map(points.map(point => {
      const mapped = mapPoint(point)
      return [pointKey(mapped.ref), mapped]
    })),
    plan: planPoll(points.map(plannedOf)),
    last: new Map(),
    nulled: false,
    online: false,
    parked: false,
    client: new ModbusRTU(),
    connectPromise: undefined,
    queueTail: Promise.resolve(),
    stopInterval: () => {},
  }
  // The client re-emits socket-level failures on itself; without a listener
  // an unheard `emit('error')` throws inside the socket's error path
  // (modbus-serial routes reads/writes through it), surfacing as an
  // unhandled rejection when a device dies mid-request. The poll cycle
  // already learns the failure through its request outcomes — this listener
  // only stops the throw.
  runtime.client.on('error', () => {})
  runtime.stopInterval = ctx.interval(() => { enqueue(runtime, () => pollDevice(runtime)) }, runtime.device.pollMs)

  // Writability gates per point at write time (points arrive incrementally
  // through the base); awaiting the queue hands the caller the real outcome.
  handle.onWrite((point, value) =>
    enqueue(runtime, async () => { await writePoint(runtime, pointKey(point), value) }))

  return {
    update(nextDevice, nextPoints): void {
      const previous = runtime.device
      const device = modbusDeviceSchema.parse(nextDevice.config)
      const pointsChanged = nextPoints.length !== runtime.points.size
        || nextPoints.some(point => {
          const existing = runtime.points.get(pointKey(point))
          return existing === undefined || JSON.stringify(existing.dialect) !== JSON.stringify(mapPoint(point).dialect)
        })
      runtime.device = device
      if (pointsChanged) {
        runtime.points = new Map(nextPoints.map(point => {
          const mapped = mapPoint(point)
          return [pointKey(mapped.ref), mapped]
        }))
        runtime.plan = planPoll(nextPoints.map(plannedOf))
        runtime.last.clear()
        runtime.nulled = false
      }
      // Link parameters changed: drop the socket; the next poll reconnects.
      if (device.host !== previous.host || device.port !== previous.port
        || device.unitId !== previous.unitId || device.timeoutMs !== previous.timeoutMs
        || device.byteOrder !== previous.byteOrder || device.enabled !== previous.enabled) {
        closeClient(runtime)
        runtime.online = false
        runtime.nulled = false
        runtime.last.clear()
      }
      // Cadence changed: retime the interval.
      if (device.pollMs !== previous.pollMs) {
        runtime.stopInterval()
        runtime.stopInterval = ctx.interval(() => { enqueue(runtime, () => pollDevice(runtime)) }, device.pollMs)
      }
      if (device.enabled && !previous.enabled) {
        runtime.parked = false
        runtime.handle.status('connecting')
      }
      if (!device.enabled && previous.enabled) {
        runtime.parked = true
        markAbnormal(runtime, '设备已停用')
      }
    },
    dispose(): void {
      runtime.stopInterval()
      closeClient(runtime)
    },
  }
}

/** The ModbusTCP driver plugin: registers the adapter with the field base. */
const modbusDriverPlugin: Plugin.Object<void> = {
  name: 'driver-modbus',
  inject: ['field', 'timer'],
  apply(ctx: Context): void {
    ctx.field.registerDriver(ctx, {
      id: 'modbus',
      title: 'Modbus TCP',
      schemas: { device: modbusDeviceSchema, point: modbusPointSchema },
      probe: async (config) => {
        const probe = await probeDevice(modbusDeviceSchema.parse(config))
        return probe.ok
          ? { ok: true, message: '连接成功' }
          : { ok: false, message: probe.error }
      },
      createConnection: (device, points, handle) => createRuntime(ctx, device, points, handle),
    })
  },
}

export default modbusDriverPlugin
