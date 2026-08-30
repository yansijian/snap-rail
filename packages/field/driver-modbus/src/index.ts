/**
 * The ModbusTCP field driver: store-declared devices become field
 * connections whose points are addressed by their (device, group, name)
 * triples. Each device runs one serial I/O queue; polling merges mapped
 * addresses into as few block reads as possible and samples only on change
 * (first read always reports; float deadband configurable per point).
 * Failures drop the connection to offline with one `null` sample per point
 * and retry every poll tick. Writes ride the field seam's write handler
 * (fc 5/6/16) and echo back as samples.
 *
 * The entry mounts the driver and its rpc bridge (`./rpc`) as one unit —
 * the bridge's `field.modbus.*` CRUD without the driver (or the reverse)
 * has no standalone value, so the two share one loader row and one toggle
 * in the plugin-management page. The package's other faces are the pure
 * `./contract` (shared wire rows) and `./station` (the renderer settings
 * page).
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
import { FieldError, type ConnectionRegistration } from '@snap-rail/field'
import {
  ConnectionId,
  pointKey,
  type PointDescriptor,
  type PointRef,
  type PointValue,
} from '@snap-rail/field'
import type { ModbusDeviceConfig, ModbusPointConfig } from './contract.ts'
import { readDocument } from './document.ts'
import '@snap-rail/store'
import { decodePoint, encodeWrite, planPoll, type BlockPayload, type PollBlock } from './plc.ts'
import modbusRpcPlugin from './rpc.ts'
import { MODBUS_TABLES } from './tables.ts'

export { probeDevice } from './probe.ts'
export { projectMapping, readDocument } from './document.ts'

/** The field address of one mapping row. */
function refOf(point: ModbusPointConfig): PointRef {
  return { device: point.deviceId, group: point.group, name: point.var }
}

interface DeviceRuntime {
  device: ModbusDeviceConfig
  registration: ConnectionRegistration
  /** Points keyed by the composite point key (`device/group/name`). */
  points: Map<string, ModbusPointConfig>
  plan: PollBlock[]
  /** Last value reported per composite key; drives change detection. */
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
 * The ModbusTCP host entry: the driver below plus the rpc bridge nested as a
 * child plugin (its own injects resolve at its fiber start, and it disposes
 * with this entry). Per-device state rides closures over the runtime map —
 * traceable context proxies rebind `this`, so service-class fields cannot
 * back this plugin (the uiSlots lesson).
 */
declare module '@snap-rail/cordis' {
  interface Events {
    /** The driver's store tables changed; the driver re-reads and reconciles per device. */
    'modbus/config-changed'(): void
  }
}

const modbusDriverPlugin: Plugin.Object<void> = {
  name: 'driver-modbus',
  inject: ['points', 'connections', 'timer', 'store', 'rpc', 'field', 'audit', 'settings'],
  apply(ctx: Context): void {
    // The bridge is a child fiber, not inlined: its own inject face stays
    // declared where its body lives (`./rpc`), and its disposers ride this
    // entry's teardown without the driver half having to know them.
    ctx.plugin(modbusRpcPlugin)
    const store = ctx.store.register(ctx, 'driver_modbus', MODBUS_TABLES)
    const runtimes = new Map<string, DeviceRuntime>()

    /** Serialize one job behind the device's tail; the returned promise
     * settles with the job's outcome (a write awaits its turn and reports
     * its failure), while the tail itself recovers so later jobs still run. */
    const enqueue = (runtime: DeviceRuntime, job: () => Promise<void>): Promise<void> => {
      const run = runtime.queueTail.then(job)
      runtime.queueTail = run.catch(() => {
        // Poll jobs already mark the device abnormal; a write outcome
        // returns to its caller. The tail stays healthy either way.
      })
      return run
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
      for (const point of runtime.points.values()) {
        runtime.registration.sample(refOf(point), null)
      }
    }

    /** Whether the fresh value is worth a frame (change-only reporting). */
    const shouldReport = (runtime: DeviceRuntime, key: string, value: PointValue): boolean => {
      const previous = runtime.last.get(key)
      if (previous === undefined || value === null) return true
      if (typeof value === 'number' && typeof previous === 'number') {
        const deadband = runtime.points.get(key)?.deadband ?? 0
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
            const value = decodePoint(point, payload, offset, runtime.device.byteOrder)
            const key = pointKey(refOf(point))
            if (!shouldReport(runtime, key, value)) continue
            runtime.last.set(key, value)
            runtime.registration.sample(refOf(point), value)
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

    const writePoint = async (runtime: DeviceRuntime, key: string, value: Exclude<PointValue, null>): Promise<void> => {
      const point = runtime.points.get(key)
      if (point === undefined || !point.writable) throw new FieldError('no-write-handler', `point ${key} is not writable`)
      await ensureConnected(runtime)
      const encoded = encodeWrite(point, value, runtime.device.byteOrder)
      if (encoded.coil !== undefined) {
        await runtime.client.writeCoil(point.address, encoded.coil)
      } else if (encoded.registers !== undefined && encoded.registers.length === 1) {
        await runtime.client.writeRegister(point.address, encoded.registers[0] as number)
      } else if (encoded.registers !== undefined) {
        await runtime.client.writeRegisters(point.address, encoded.registers)
      }
      // Echo the write as the fresh sample; the next poll compares against it.
      runtime.last.set(key, value)
      runtime.registration.sample(refOf(point), value)
    }

    const closeClient = (runtime: DeviceRuntime): void => {
      try {
        // The callback flavor of close() never mints a promise; without one,
        // the promise API rejects on a dead socket (ECONNRESET) and nobody
        // would be there to handle it.
        if (runtime.client.isOpen) runtime.client.close(() => {})
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
      const pointMap = new Map(points.map(point => [pointKey(refOf(point)), point]))
      const descriptors: PointDescriptor[] = points.map(point => ({
        device: point.deviceId,
        group: point.group,
        name: point.var,
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
          // Await the queue: the caller (the field seam, then the rpc
          // bridge's audit) learns the write's real outcome.
          return enqueue(runtime, async () => { await writePoint(runtime, pointKey(point), value) })
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
      // The client re-emits socket-level failures on itself; without a
      // listener an unheard `emit('error')` throws inside the socket's error
      // path (modbus-serial routes reads/writes through it), surfacing as an
      // unhandled rejection when a device dies mid-request. The poll cycle
      // already learns the failure through its request outcomes — this
      // listener only stops the throw.
      runtime.client.on('error', () => {})
      runtime.stopInterval = ctx.interval(() => { enqueue(runtime, () => pollDevice(runtime)) }, device.pollMs)
      return runtime
    }

    /** Same link parameters (word order included) and same point table →
     * keep the live runtime. Group rides in the point identity, so moving a
     * point rebuilds its device — by design. */
    const sameShape = (runtime: DeviceRuntime, device: ModbusDeviceConfig, points: readonly ModbusPointConfig[]): boolean =>
      JSON.stringify(runtime.device) === JSON.stringify(device)
        && runtime.points.size === points.length
        && points.every(point => {
          const existing = runtime.points.get(pointKey(refOf(point)))
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
