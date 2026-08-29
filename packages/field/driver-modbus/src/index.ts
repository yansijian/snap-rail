/**
 * The ModbusTCP field driver: store-declared devices become field
 * connections whose point ids are the variable names themselves. Each device
 * runs one serial I/O queue; polling merges mapped addresses into as few
 * block reads as possible and samples only on change (first read always
 * reports; float deadband configurable per point). Failures drop the
 * connection to offline with one `null` sample per point and retry every
 * poll tick. Writes ride the field seam's write handler (fc 5/6/16) and echo
 * back as samples.
 *
 * Config changes flow through the bridge's `modbus/config-changed` event;
 * reconciliation restarts only the devices whose link parameters or point
 * table actually changed.
 *
 * @module @snap-rail/driver-modbus
 */

import ModbusRTU from 'modbus-serial'
import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the `ctx.points` /
// `ctx.connections` declaration merging alongside the runtime service.
import '@snap-rail/field'
import type { ConnectionRegistration } from '@snap-rail/field'
import {
  ConnectionId,
  PointId,
  type ModbusDeviceConfig,
  type ModbusPointConfig,
  type PointDescriptor,
  type PointValue,
} from '@snap-rail/protocol'
import '@snap-rail/store'
import type { StoreHandle } from '@snap-rail/store'
import { decodePoint, encodeWrite, planPoll, type BlockPayload, type PollBlock } from './plc.ts'
import { MODBUS_TABLES } from './tables.ts'

/** Row layout of the driver's store namespace. */
export interface ModbusDocument {
  devices: ModbusDeviceConfig[]
  points: ModbusPointConfig[]
  vars: Array<{ name: string, type: 'bool' | 'int' | 'float' }>
}

/** Read the whole document (devices ascending, points by variable). */
export function readDocument(store: StoreHandle): ModbusDocument {
  const devices = store.all<Record<string, unknown>>(`SELECT * FROM ${store.table('devices')} ORDER BY id`)
    .map(rowFromDevice)
  const points = store.all<Record<string, unknown>>(`SELECT * FROM ${store.table('points')} ORDER BY var`)
    .map(rowFromPoint)
  const vars = store.all<{ name: string, type: 'bool' | 'int' | 'float' }>(
    `SELECT name, type FROM ${store.table('vars')} ORDER BY name`)
  return { devices, points, vars }
}

type DeviceRow = Record<string, unknown>

function rowFromDevice(row: DeviceRow): ModbusDeviceConfig {
  return {
    id: String(row.id),
    title: String(row.title),
    host: String(row.host),
    port: Number(row.port),
    unitId: Number(row.unit_id),
    pollMs: Number(row.poll_ms),
    timeoutMs: Number(row.timeout_ms),
    enabled: Number(row.enabled) === 1,
  }
}

function rowFromPoint(row: DeviceRow): ModbusPointConfig {
  return {
    var: String(row.var),
    deviceId: String(row.device_id),
    type: row.type as ModbusPointConfig['type'],
    fc: Number(row.fc) as ModbusPointConfig['fc'],
    address: Number(row.address),
    encoding: row.encoding as ModbusPointConfig['encoding'],
    byteOrder: row.byte_order as ModbusPointConfig['byteOrder'],
    scale: row.scale === null ? undefined : Number(row.scale),
    writable: Number(row.writable) === 1,
    deadband: row.deadband === null ? undefined : Number(row.deadband),
  }
}

interface DeviceRuntime {
  device: ModbusDeviceConfig
  registration: ConnectionRegistration
  points: Map<string, ModbusPointConfig>
  plan: PollBlock[]
  /** Last value reported per variable; drives change detection. */
  last: Map<string, PointValue>
  /** Whether the current abnormal state already pushed one `null` round. */
  nulled: boolean
  online: boolean
  client: ModbusRTU
  connectPromise: Promise<void> | undefined
  queueTail: Promise<void>
  stopInterval: () => void
}

/**
 * The ModbusTCP driver. Per-device state rides closures over the runtime
 * map — traceable context proxies rebind `this`, so service-class fields
 * cannot back this plugin (the uiSlots lesson).
 */
declare module '@snap-rail/cordis' {
  interface Events {
    /** The driver's store tables changed; the driver re-reads and reconciles per device. */
    'modbus/config-changed'(): void
  }
}

const modbusDriverPlugin: Plugin.Object<void> = {
  name: 'driver-modbus',
  inject: ['points', 'connections', 'timer', 'store'],
  apply(ctx: Context): void {
    const store = ctx.store.register(ctx, 'driver_modbus', MODBUS_TABLES)
    const runtimes = new Map<string, DeviceRuntime>()

    const enqueue = (runtime: DeviceRuntime, job: () => Promise<void>): void => {
      runtime.queueTail = runtime.queueTail
        .then(job)
        .catch(() => {
          // Poll jobs already mark the device abnormal; write jobs echo only
          // on success. Anything left here is a queue-ordering anomaly.
        })
    }

    /** Ports already carrying the write guard (one guard per port instance). */
    const guardedPorts = new WeakSet<object>()

    /**
     * modbus-serial's TcpPort.write routes a synchronous throw — a write
     * attempted after the socket died — into a promise chain nothing
     * upstream ever handles (their dropped `.finally`), which surfaces as
     * an unhandled process rejection. Swallow the throw at the port: the
     * abandoned request then fails through its own timeout path. Each
     * reconnect builds a fresh port, so the guard re-applies per
     * connection.
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
    const markAbnormal = (runtime: DeviceRuntime): void => {
      runtime.online = false
      runtime.registration.setStatus('offline')
      // Drop the socket so the next poll reconnects from scratch; a
      // half-open TCP connection would otherwise never recover.
      try {
        if (runtime.client.isOpen) runtime.client.close(() => {})
      } catch {
        // The socket may already be gone.
      }
      if (runtime.nulled) return
      runtime.nulled = true
      runtime.last.clear()
      for (const name of runtime.points.keys()) {
        runtime.registration.sample(PointId(name), null)
      }
    }

    /** Whether the fresh value is worth a frame (change-only reporting). */
    const shouldReport = (runtime: DeviceRuntime, point: ModbusPointConfig, value: PointValue): boolean => {
      const previous = runtime.last.get(point.var)
      if (previous === undefined || value === null) return true
      if (typeof value === 'number' && typeof previous === 'number') {
        const deadband = point.deadband ?? 0
        return Math.abs(value - previous) > deadband
      }
      return value !== previous
    }

    const pollDevice = async (runtime: DeviceRuntime): Promise<void> => {
      if (!runtime.device.enabled) return
      try {
        await ensureConnected(runtime)
        for (const block of runtime.plan) {
          const payload = await readBlock(runtime.client, block)
          for (const { point, offset } of block.entries) {
            const value = decodePoint(point, payload, offset)
            if (!shouldReport(runtime, point, value)) continue
            runtime.last.set(point.var, value)
            runtime.registration.sample(PointId(point.var), value)
          }
        }
        if (!runtime.online) {
          runtime.online = true
          runtime.registration.setStatus('online')
        }
        runtime.nulled = false
      } catch {
        markAbnormal(runtime)
      }
    }

    const writePoint = async (runtime: DeviceRuntime, name: string, value: Exclude<PointValue, null>): Promise<void> => {
      const point = runtime.points.get(name)
      if (point === undefined || !point.writable) throw new Error(`point ${name} is not writable`)
      await ensureConnected(runtime)
      const encoded = encodeWrite(point, value)
      if (encoded.coil !== undefined) {
        await runtime.client.writeCoil(point.address, encoded.coil)
      } else if (encoded.registers !== undefined && encoded.registers.length === 1) {
        await runtime.client.writeRegister(point.address, encoded.registers[0] as number)
      } else if (encoded.registers !== undefined) {
        await runtime.client.writeRegisters(point.address, encoded.registers)
      }
      // Echo the write as the fresh sample; the next poll compares against it.
      runtime.last.set(name, value)
      runtime.registration.sample(PointId(name), value)
    }

    const closeClient = (runtime: DeviceRuntime): void => {
      try {
        if (runtime.client.isOpen) void runtime.client.close()
      } catch {
        // A half-open socket may refuse close; the OS reclaims it.
      }
    }

    const teardown = (runtime: DeviceRuntime): void => {
      runtime.stopInterval()
      runtime.registration.dispose()
      closeClient(runtime)
    }

    const createRuntime = (device: ModbusDeviceConfig, points: readonly ModbusPointConfig[]): DeviceRuntime => {
      const pointMap = new Map(points.map(point => [point.var, point]))
      const descriptors: PointDescriptor[] = points.map(point => ({
        id: PointId(point.var),
        connection: ConnectionId(device.id),
        type: point.type,
      }))
      const registration = ctx.connections.register(ctx, {
        id: ConnectionId(device.id),
        driver: 'driver-modbus',
        title: device.title,
      })
      registration.setPoints(descriptors)
      registration.setStatus('offline')
      if (points.some(point => point.writable)) {
        registration.setWriteHandler((point, value) => {
          const runtime = runtimes.get(device.id)
          if (runtime === undefined) return Promise.resolve()
          enqueue(runtime, async () => { await writePoint(runtime, point.id, value) })
        })
      }
      const runtime: DeviceRuntime = {
        device,
        registration,
        points: pointMap,
        plan: planPoll(points),
        last: new Map(),
        nulled: false,
        online: false,
        client: new ModbusRTU(),
        connectPromise: undefined,
        queueTail: Promise.resolve(),
        stopInterval: () => {},
      }
      runtime.stopInterval = ctx.interval(() => { enqueue(runtime, () => pollDevice(runtime)) }, device.pollMs)
      return runtime
    }

    /** Same link parameters and same point table → keep the live runtime. */
    const sameShape = (runtime: DeviceRuntime, device: ModbusDeviceConfig, points: readonly ModbusPointConfig[]): boolean =>
      JSON.stringify(runtime.device) === JSON.stringify(device)
      && runtime.points.size === points.length
      && points.every(point => {
        const existing = runtime.points.get(point.var)
        return existing !== undefined && JSON.stringify(existing) === JSON.stringify(point)
      })

    const reconcile = (): void => {
      const doc = readDocument(store)
      const wanted = new Map<string, { device: ModbusDeviceConfig, points: ModbusPointConfig[] }>()
      for (const device of doc.devices) {
        if (!device.enabled) continue
        wanted.set(device.id, { device, points: doc.points.filter(point => point.deviceId === device.id) })
      }
      for (const [id, runtime] of [...runtimes]) {
        const want = wanted.get(id)
        if (want === undefined || !sameShape(runtime, want.device, want.points)) {
          teardown(runtime)
          runtimes.delete(id)
        }
      }
      for (const [id, want] of wanted) {
        if (!runtimes.has(id)) runtimes.set(id, createRuntime(want.device, want.points))
      }
    }

    ctx.on('modbus/config-changed', () => { reconcile() })
    // Effects take a body producing the disposer; initial reconcile rides it too.
    ctx.effect(() => {
      reconcile()
      return () => {
        for (const runtime of runtimes.values()) teardown(runtime)
        runtimes.clear()
      }
    })
  },
}

export default modbusDriverPlugin
