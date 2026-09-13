/**
 * The EtherNet/IP equipment driver: a pure protocol adapter over the
 * equipment base. The base owns the device/group/point tables and calls
 * `createConnection` per configured device; this runtime keeps one ENIP
 * session per device behind a serial I/O queue, polls every published
 * variable by name, and samples only on change (first read always reports;
 * numeric deadband per point). Transport failures drop the link to offline
 * with one `null` sample per point and retry every poll tick; a single
 * variable's CIP failure (unknown or mistyped) stays per-point — one null,
 * suppressed until its config changes, the device remains online. Writes
 * carry the type word learned from the variable's first read and echo back
 * as samples.
 *
 * Update policy (the driver decides, the base orchestrates): host/port/
 * slot/timeoutMs changes drop the session and reconnect on the next poll;
 * point-table changes re-map in place; pollMs changes retime the interval;
 * `enabled: false` parks the device (no polling, offline).
 *
 * @module @snap-rail/driver-enip
 */

import * as net from 'node:net'
import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the equipment seam: the import pulls in the driver-registration
// declaration merging alongside the runtime service.
import '@snap-rail/equipment'
import {
  EquipmentError,
  pointKey,
  type DriverConnection,
  type DriverDevice,
  type DriverHandle,
  type DriverPoint,
  type PointRef,
  type PointValue,
} from '@snap-rail/equipment'
import {
  ENIP_HEADER_BYTES,
  buildReadTag,
  buildWriteTag,
  busTypeOf,
  COMMAND_REGISTER_SESSION,
  COMMAND_SEND_RR_DATA,
  decodeReadReply,
  encodeValue,
  packHeader,
  packRegisterSession,
  packSendRrData,
  parseHeader,
  unpackSendRrData,
  type ReadReply,
} from './enip.ts'
import { enipDeviceSchema, enipPointSchema, type EnipDeviceConfig, type EnipPointConfig } from './contract.ts'

export { enipDeviceSchema, enipPointSchema } from './contract.ts'
export type { EnipDeviceConfig, EnipPointConfig } from './contract.ts'

/** Parse a stored point config; drift from schema evolution surfaces as a
 * readable equipment error instead of a raw ZodError escaping the seam. */
const parsePoint = (point: DriverPoint): EnipPointConfig => {
  const parsed = enipPointSchema.safeParse({ type: point.type, ...point.config })
  if (!parsed.success) {
    throw new EquipmentError('invalid-config', `point ${pointKey(point)} config rejected: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return parsed.data
}

/** Parse a stored device config (the same drift guard points get). */
const parseDevice = (config: DriverDevice['config']): EnipDeviceConfig => {
  const parsed = enipDeviceSchema.safeParse(config)
  if (!parsed.success) {
    throw new EquipmentError('invalid-config', `device config rejected: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return parsed.data
}

/** One mapped point as the runtime addresses it: the triple plus its dialect. */
function mapPoint(point: DriverPoint): MappedPoint {
  return {
    ref: { device: point.device, group: point.group, name: point.name },
    dialect: parsePoint(point),
  }
}

interface MappedPoint {
  ref: PointRef
  dialect: EnipPointConfig
}

interface DeviceRuntime {
  device: EnipDeviceConfig
  handle: DriverHandle
  /** Points keyed by the composite point key (`device/group/name`). */
  points: Map<string, MappedPoint>
  /** Reply type word learned per point key; writes ride it. */
  types: Map<string, number>
  /** Points already carrying their verdict (unknown or mistyped variable);
   * suppressed until their config changes. */
  failed: Set<string>
  /** Last value reported per composite key; drives change detection. */
  last: Map<string, PointValue>
  /** Whether the current abnormal state already pushed one `null` round. */
  nulled: boolean
  online: boolean
  parked: boolean
  session: EnipSession
  connectPromise: Promise<void> | undefined
  queueTail: Promise<void>
  stopInterval: () => void
}

/** One ENIP session over a TCP socket. The runtime serializes requests per
 * device, so one in-flight request at a time suffices; a per-request timer
 * races the reply and a dead link surfaces as the request's own rejection. */
class EnipSession {
  private socket: net.Socket | undefined
  private carry: Buffer = Buffer.alloc(0)
  private inflight: {
    resolve: (frame: Buffer) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | undefined
  private sequence = 0n
  /** The registered session handle; 0 until RegisterSession answers. */
  private handle = 0

  get isOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === 'open' && this.handle !== 0
  }

  /** Dial and register the session; failures reject and drop the socket. */
  async connect(host: string, port: number, timeoutMs: number): Promise<void> {
    this.destroy()
    const socket = net.connect({ host, port })
    this.socket = socket
    // Outcomes surface through the request verdicts; the socket's own error
    // events only decide pending promises and never throw unhandled.
    socket.on('error', () => {})
    socket.on('data', chunk => this.receive(chunk))
    socket.on('close', () => {
      this.socket = undefined
      this.handle = 0
      this.settle(new Error('ENIP session closed'))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs}ms`)), timeoutMs)
        socket.once('connect', () => { clearTimeout(timer); resolve() })
        socket.once('error', cause => { clearTimeout(timer); reject(cause) })
      })
      const reply = await this.exchange(COMMAND_REGISTER_SESSION, packRegisterSession(), timeoutMs)
      this.handle = parseHeader(reply).session
    } catch (cause) {
      this.destroy()
      throw cause
    }
  }

  /** Send one CIP request and await its CIP reply body (CPF envelope off). */
  async send(cip: Buffer, timeoutMs: number): Promise<Buffer> {
    const frame = await this.exchange(COMMAND_SEND_RR_DATA, cip, timeoutMs)
    return unpackSendRrData(frame)
  }

  /** Wrap one command, ship it, and race its reply against the timer. */
  private exchange(command: number, body: Buffer, timeoutMs: number): Promise<Buffer> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 'open') {
      throw new Error('ENIP session is not open')
    }
    const sender = ++this.sequence
    const payload = command === COMMAND_SEND_RR_DATA
      ? packSendRrData(body, sender, this.handle)
      : packHeader({ command, session: this.handle, status: 0, sender }, body)
    return new Promise<Buffer>((resolve, reject) => {
      this.inflight = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // A request that outlives its timer leaves the link suspect —
          // drop it so the next poll redials from scratch.
          this.inflight = undefined
          this.destroy()
          reject(new Error(`ENIP request timed out after ${timeoutMs}ms`))
        }, timeoutMs),
      }
      socket.write(payload)
    })
  }

  /** Assemble frames off the byte stream and hand each to its request. */
  private receive(chunk: Buffer): void {
    this.carry = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk])
    while (this.carry.length >= ENIP_HEADER_BYTES) {
      const total = ENIP_HEADER_BYTES + this.carry.readUInt16LE(2)
      if (this.carry.length < total) break
      const frame = this.carry.subarray(0, total)
      this.carry = this.carry.subarray(total)
      this.arrive(frame)
    }
  }

  private arrive(frame: Buffer): void {
    const inflight = this.inflight
    if (inflight === undefined) return // a late reply after its own timeout
    const header = parseHeader(frame)
    if (header.status !== 0) {
      this.settle(new Error(`ENIP command 0x${header.command.toString(16)} failed with status ${header.status}`))
      return
    }
    this.inflight = undefined
    clearTimeout(inflight.timer)
    inflight.resolve(frame)
  }

  /** Settle the pending request (if any) with a rejection. */
  private settle(cause: Error): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    this.inflight = undefined
    clearTimeout(inflight.timer)
    inflight.reject(cause)
  }

  destroy(): void {
    this.settle(new Error('ENIP session destroyed'))
    this.carry = Buffer.alloc(0)
    if (this.socket !== undefined) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = undefined
    }
    this.handle = 0
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

const ensureConnected = async (runtime: DeviceRuntime): Promise<void> => {
  if (runtime.session.isOpen) return
  runtime.connectPromise ??= runtime.session
    .connect(runtime.device.host, runtime.device.port, runtime.device.timeoutMs)
    .finally(() => { runtime.connectPromise = undefined })
  await runtime.connectPromise
}

/** One abnormal cycle: offline, one `null` per point, forget last values.
 * Variable-level failures never land here — they stay per-point. */
const markAbnormal = (runtime: DeviceRuntime, message?: string): void => {
  runtime.online = false
  runtime.handle.status('offline', message)
  // Drop the session so the next poll reconnects from scratch; a half-open
  // TCP connection would otherwise never recover.
  runtime.session.destroy()
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
  if ((typeof value === 'number' || typeof value === 'bigint')
    && (typeof previous === 'number' || typeof previous === 'bigint')) {
    const deadband = runtime.points.get(key)?.dialect.deadband ?? 0
    return Math.abs(Number(value) - Number(previous)) > deadband
  }
  return value !== previous
}

/** One variable's read verdict: publish, or fail the point alone. */
const publish = (runtime: DeviceRuntime, key: string, point: MappedPoint, reply: ReadReply): void => {
  if (reply.status !== 0) {
    failPoint(runtime, key)
    return
  }
  const type = reply.type
  if (type === undefined || busTypeOf(type) !== point.dialect.type) {
    // The variable exists but carries a type outside the group's — the
    // runtime analog of the modbus encoding↔type refinement.
    failPoint(runtime, key)
    return
  }
  runtime.types.set(key, type)
  const value = reply.value
  if (value === undefined || !shouldReport(runtime, key, value)) return
  runtime.last.set(key, value)
  runtime.handle.sample(point.ref, value)
}

/** One null round for a single point, then suppression until reconfig. */
const failPoint = (runtime: DeviceRuntime, key: string): void => {
  if (runtime.failed.has(key)) return
  runtime.failed.add(key)
  runtime.last.delete(key)
  const point = runtime.points.get(key)
  if (point !== undefined) runtime.handle.sample(point.ref, null)
}

/** Read one variable's type word (the write path's learning step). */
const readType = async (runtime: DeviceRuntime, key: string, point: MappedPoint): Promise<number> => {
  const reply = decodeReadReply(await runtime.session.send(buildReadTag(point.dialect.tag, runtime.device.slot), runtime.device.timeoutMs))
  const type = reply.type
  if (reply.status !== 0 || type === undefined || busTypeOf(type) !== point.dialect.type) {
    throw new EquipmentError('invalid-config', `point ${key} variable ${point.dialect.tag} does not carry the group's ${point.dialect.type} type`)
  }
  return type
}

const pollDevice = async (runtime: DeviceRuntime): Promise<void> => {
  if (runtime.parked) return
  try {
    await ensureConnected(runtime)
    if (!runtime.online) {
      runtime.online = true
      runtime.handle.status('online')
    }
    for (const [key, point] of runtime.points) {
      if (runtime.failed.has(key)) continue
      const body = await runtime.session.send(buildReadTag(point.dialect.tag, runtime.device.slot), runtime.device.timeoutMs)
      publish(runtime, key, point, decodeReadReply(body))
    }
    runtime.nulled = false
  } catch (cause) {
    markAbnormal(runtime, cause instanceof Error ? cause.message : String(cause))
  }
}

const writePoint = async (runtime: DeviceRuntime, key: string, value: Exclude<PointValue, null>): Promise<void> => {
  const point = runtime.points.get(key)
  if (point === undefined || !point.dialect.writable) {
    throw new EquipmentError('no-write-handler', `point ${key} is not writable`)
  }
  // The dialect's point types are bool/int/float; the base's own write
  // check already rejects strings for such groups — this narrows the type.
  if (typeof value === 'string') {
    throw new EquipmentError('type-mismatch', `point ${key} does not carry string values`)
  }
  await ensureConnected(runtime)
  // Writes carry the type word; learn it from a read when unlearned.
  const type = runtime.types.get(key) ?? await readType(runtime, key, point)
  runtime.types.set(key, type)
  await runtime.session.send(buildWriteTag(point.dialect.tag, runtime.device.slot, type, encodeValue(type, value)), runtime.device.timeoutMs)
  // Echo the write as the fresh sample; the next poll compares against it.
  runtime.last.set(key, value)
  runtime.handle.sample(point.ref, value)
}

/** Build the per-device runtime: the connection controller this driver owns. */
const createRuntime = (ctx: Context, device: DriverDevice, points: readonly DriverPoint[], handle: DriverHandle): DriverConnection => {
  const runtime: DeviceRuntime = {
    device: parseDevice(device.config),
    handle,
    points: new Map(points.map(point => {
      const mapped = mapPoint(point)
      return [pointKey(mapped.ref), mapped]
    })),
    types: new Map(),
    failed: new Set(),
    last: new Map(),
    nulled: false,
    online: false,
    parked: false,
    session: new EnipSession(),
    connectPromise: undefined,
    queueTail: Promise.resolve(),
    stopInterval: () => {},
  }
  runtime.stopInterval = ctx.interval(() => { enqueue(runtime, () => pollDevice(runtime)) }, runtime.device.pollMs)

  // Writability gates per point at write time (points arrive incrementally
  // through the base); awaiting the queue hands the caller the real outcome.
  handle.onWrite((point, value) =>
    enqueue(runtime, async () => { await writePoint(runtime, pointKey(point), value) }))

  return {
    update(nextDevice, nextPoints): void {
      const previous = runtime.device
      const device = parseDevice(nextDevice.config)
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
        // Types and failures are per-config verdicts; relearn them.
        runtime.types = new Map()
        runtime.failed = new Set()
        runtime.last.clear()
        runtime.nulled = false
      }
      // Link parameters changed: drop the session; the next poll reconnects.
      if (device.host !== previous.host || device.port !== previous.port
        || device.slot !== previous.slot || device.timeoutMs !== previous.timeoutMs
        || device.enabled !== previous.enabled) {
        runtime.session.destroy()
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
      runtime.session.destroy()
    },
  }
}

/** The EtherNet/IP driver plugin: registers the adapter with the equipment base. */
const enipDriverPlugin: Plugin.Object<void> = {
  name: 'driver-enip',
  inject: ['equipment', 'timer'],
  apply(ctx: Context): void {
    ctx.equipment.registerDriver(ctx, {
      id: 'enip',
      title: 'EtherNet/IP',
      schemas: { device: enipDeviceSchema, point: enipPointSchema },
      createConnection: (device, points, handle) => createRuntime(ctx, device, points, handle),
    })
  },
}

export default enipDriverPlugin
