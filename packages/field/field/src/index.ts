/**
 * The field seam: the live point table. Drivers (providers) register
 * connections and push samples; dashboards, alarms, and agents (consumers)
 * subscribe, read, and write. The seam is protocol-agnostic; the `./rpc`
 * subpath is its gateway bridge.
 *
 * Addressing: a point's address is the (device, group, name) triple — there
 * is no opaque id; the composite `pointKey` exists only as the host-side
 * map key and audit subject.
 *
 * Semantics: a `null` value means the point is abnormal (unreadable or
 * stale); connection-level failure is the connection status. Writes are
 * routed to the owning driver and type-checked against the point's declared
 * semantic type.
 *
 * @module @snap-rail/field
 */

import { Context, Service, type Plugin } from '@snap-rail/cordis'
import type { MappingDevice, MappingDocument, MappingGroup, MappingPoint } from './mapping.ts'
import {
  ConnectionId,
  pointKey,
  pointRefSchema,
  type ConnectionDescriptor,
  type ConnectionSnapshot,
  type ConnectionStatus,
  type ConnectionStatusFrame,
  type PointDescriptor,
  type PointRef,
  type PointSample,
  type PointType,
  type PointValue,
} from './model.ts'
import type { DriverInfo } from './wire.ts'

export { ConnectionId, pointKey, pointRefSchema }
export type {
  ConnectionDescriptor, ConnectionSnapshot, ConnectionStatus, ConnectionStatusFrame,
  PointDescriptor, PointRef, PointSample, PointType, PointValue,
}
export type { MappingDevice, MappingDocument, MappingGroup, MappingPoint }
export type { DriverInfo }
export * from './wire.ts'

/** Failure kinds raised by the field seam (the rpc bridge maps them to wire errors). */
export type FieldErrorKind = 'duplicate-connection' | 'duplicate-point' | 'duplicate-driver' | 'unknown-point' | 'type-mismatch' | 'no-write-handler'

/** A field-seam failure carrying a machine-readable kind. */
export class FieldError extends Error {
  constructor(public readonly kind: FieldErrorKind, message: string) {
    super(`field: ${message}`)
    this.name = 'FieldError'
  }
}

/** Handler receiving writes routed to a driver's connection. */
export type WriteHandler = (point: PointDescriptor, value: Exclude<PointValue, null>) => Promise<void> | void

/** The provider-side handle returned by connection registration. */
export interface ConnectionRegistration {
  /** Replace this connection's point set wholesale; diffed into added/removed events. */
  setPoints(points: readonly PointDescriptor[]): void
  /** Push one sample for the addressed point; `null` marks it abnormal. */
  sample(ref: PointRef, value: PointValue): void
  /** Announce connection status; offline leaves reads to the driver's null samples. */
  setStatus(status: ConnectionStatus): void
  /** Install the write handler (once); writes before this fail `no-write-handler`. */
  setWriteHandler(handler: WriteHandler): void
  /** Remove the connection and its points; also runs automatically when the registering fiber unloads. */
  dispose(): void
}

interface ConnectionEntry {
  desc: ConnectionDescriptor
  status: ConnectionStatus
  points: Map<string, PointDescriptor>
  values: Map<string, PointSample>
  writeHandler?: WriteHandler
}

interface DriverEntry {
  info: DriverInfo
  mappings?: () => MappingDocument
}

declare module '@snap-rail/cordis' {
  interface Context {
    points: PointsService
    connections: ConnectionsService
    field: FieldService
  }

  interface Events {
    /** A point entered the point table.
     * @param point - the descriptor now visible. */
    'point/added'(point: PointDescriptor): void
    /** A point left the point table.
     * @param ref - the removed point's address. */
    'point/removed'(ref: PointRef): void
    /** A point produced a new sample (including `null` = abnormal).
     * @param sample - the fresh sample. */
    'point/updated'(sample: PointSample): void
    /** A connection was registered.
     * @param snapshot - descriptor plus initial (offline) status. */
    'connection/added'(snapshot: ConnectionSnapshot): void
    /** A connection was removed.
     * @param id - the removed connection id. */
    'connection/removed'(id: ConnectionId): void
    /** A connection changed status.
     * @param frame - the new status with its timestamp. */
    'connection/status'(frame: ConnectionStatusFrame): void
    /** A driver's mapping tables changed; the rpc bridge rebroadcasts the
     * `field/mappings-changed` wire frame. */
    'field/mappings-changed'(): void
  }
}

/** Read/subscribe/write surface of the point table. */
export interface PointsService {
  /** Every point currently in the table. */
  list(): readonly PointDescriptor[]
  /** The latest sample of a point, or `undefined` before its first sample. */
  read(ref: PointRef): PointSample | undefined
  /** Observe updates for a set of points; returns the unsubscribe function. */
  subscribe(refs: readonly PointRef[], listener: (sample: PointSample) => void): () => void
  /** Write a control value; routed to the owning driver after type validation. */
  write(ref: PointRef, value: Exclude<PointValue, null>): Promise<void>
}

/** Provider/consumer surface of connections. */
export interface ConnectionsService {
  /** Every connection with live status. */
  list(): readonly ConnectionSnapshot[]
  /** Observe status changes; returns the unsubscribe function. */
  subscribeStatus(listener: (frame: ConnectionStatusFrame) => void): () => void
  /** Register a connection owned by the caller; disposal rides the caller's fiber.
   * @param caller - the driver plugin's context; unloading it removes the connection.
   * @param desc - the connection descriptor.
   * @returns the provider-side handle.
   */
  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration
}

/** What a driver registers with the field seam: identity plus an optional
 * dialect-free mapping projection. The id doubles as the driver's wire
 * sub-namespace (`field.<id>.*`, claimed by the driver's own rpc module). */
export interface DriverRegistration {
  /** Driver id — lowercase kebab; unique across registered drivers. */
  id: string
  /** Human-facing title served by `field.drivers.list`. */
  title: string
  /** The driver's mapping tables projected into the generic view; omit when
   * the driver declares points statically (mock) and has no mapping tables. */
  mappings?: () => MappingDocument
}

/** The field domain's driver registry: who is plugged in and how demand-side
 * bindings see their mapping tables. */
export interface FieldService {
  /** Registered drivers in registration order. */
  listDrivers(): readonly DriverInfo[]
  /** The aggregated mapping document across drivers that provide projections. */
  mappings(): MappingDocument
  /** A driver calls this after its mapping tables change; the rpc bridge
   * rebroadcasts the `field/mappings-changed` frame so bindings re-resolve. */
  mappingsChanged(): void
  /** Register a driver; disposal rides the caller's fiber.
   * @param caller - the driver's context; unloading it removes the registration.
   * @param desc - identity plus the optional mapping projection.
   */
  registerDriver(caller: Context, desc: DriverRegistration): () => void
}

function expectedValueType(type: PointType): string {
  switch (type) {
    case 'bool': return 'boolean'
    case 'int': return 'bigint'
    case 'float': return 'number'
    case 'string': return 'string'
  }
}

class FieldCore {
  readonly connections = new Map<ConnectionId, ConnectionEntry>()
  /** Composite point key → owning connection id. */
  readonly pointIndex = new Map<string, ConnectionId>()
  readonly drivers = new Map<string, DriverEntry>()

  constructor(private readonly ctx: Context) {}

  registerDriver(caller: Context, desc: DriverRegistration): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(desc.id) || desc.title.trim() === '') {
      throw new FieldError('duplicate-driver', `invalid driver registration (id "${desc.id}", title "${desc.title}")`)
    }
    const entry: DriverEntry = {
      info: { id: desc.id, title: desc.title },
      ...(desc.mappings !== undefined ? { mappings: desc.mappings } : {}),
    }
    // A same-id registration replaces (hot-reload semantics; two instances
    // of one driver package are one driver with two connections).
    this.drivers.set(desc.id, entry)
    const dispose = (): void => {
      if (this.drivers.get(desc.id) === entry) this.drivers.delete(desc.id)
    }
    caller.effect(() => dispose)
    return dispose
  }

  mappings(): MappingDocument {
    const devices: MappingDevice[] = []
    const groups: MappingGroup[] = []
    const points: MappingPoint[] = []
    for (const entry of this.drivers.values()) {
      if (entry.mappings === undefined) continue
      const doc = entry.mappings()
      // The seam stamps the owning driver — projections stay honest for free.
      for (const device of doc.devices) devices.push({ id: device.id, driver: entry.info.id })
      groups.push(...doc.groups)
      points.push(...doc.points)
    }
    return { devices, groups, points }
  }

  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration {
    if (this.connections.has(desc.id)) {
      throw new FieldError('duplicate-connection', `connection ${desc.id} is already registered`)
    }
    const entry: ConnectionEntry = { desc, status: 'offline', points: new Map(), values: new Map() }
    this.connections.set(desc.id, entry)
    this.ctx.emit('connection/added', { ...desc, status: entry.status })
    const dispose = () => this.remove(desc.id)
    caller.effect(() => dispose)
    const assertOwned = (ref: PointRef): PointDescriptor | undefined => {
      const key = pointKey(ref)
      const owner = this.pointIndex.get(key)
      if (owner === undefined || owner !== desc.id) return undefined
      return entry.points.get(key)
    }
    return {
      setPoints: points => this.setPoints(entry, points),
      sample: (ref, value) => {
        const point = assertOwned(ref)
        if (point === undefined) {
          throw new FieldError('unknown-point', `connection ${desc.id} sampled unregistered point ${pointKey(ref)}`)
        }
        const sample: PointSample = { device: point.device, group: point.group, name: point.name, value, time: Date.now() }
        entry.values.set(pointKey(point), sample)
        this.ctx.emit('point/updated', sample)
      },
      setStatus: status => {
        if (entry.status === status) return
        entry.status = status
        this.ctx.emit('connection/status', { id: desc.id, status, time: Date.now() })
      },
      setWriteHandler: handler => {
        entry.writeHandler = handler
      },
      dispose,
    }
  }

  private setPoints(entry: ConnectionEntry, points: readonly PointDescriptor[]): void {
    const next = new Map(points.map(point => [pointKey(point), point]))
    for (const key of next.keys()) {
      const owner = this.pointIndex.get(key)
      if (owner !== undefined && owner !== entry.desc.id) {
        throw new FieldError('duplicate-point', `point ${key} is already registered by connection ${owner}`)
      }
    }
    for (const [key, point] of [...entry.points]) {
      if (!next.has(key)) {
        entry.points.delete(key)
        entry.values.delete(key)
        this.pointIndex.delete(key)
        this.ctx.emit('point/removed', { device: point.device, group: point.group, name: point.name })
      }
    }
    for (const [key, point] of next) {
      if (entry.points.has(key)) continue
      entry.points.set(key, point)
      this.pointIndex.set(key, entry.desc.id)
      this.ctx.emit('point/added', point)
    }
  }

  private remove(id: ConnectionId): void {
    const entry = this.connections.get(id)
    if (entry === undefined) return
    for (const [key, point] of entry.points) {
      this.pointIndex.delete(key)
      this.ctx.emit('point/removed', { device: point.device, group: point.group, name: point.name })
    }
    this.connections.delete(id)
    this.ctx.emit('connection/removed', id)
  }

  write(ref: PointRef, value: Exclude<PointValue, null>): Promise<void> {
    const key = pointKey(ref)
    const owner = this.pointIndex.get(key)
    if (owner === undefined) throw new FieldError('unknown-point', `write to unknown point ${key}`)
    const entry = this.connections.get(owner)
    const point = entry?.points.get(key)
    if (entry === undefined || point === undefined) {
      throw new FieldError('unknown-point', `write to unknown point ${key}`)
    }
    const expected = expectedValueType(point.type)
    if (typeof value !== expected) {
      throw new FieldError('type-mismatch', `point ${key} expects ${point.type} (${expected}), received ${typeof value}`)
    }
    const handler = entry.writeHandler
    if (handler === undefined) {
      throw new FieldError('no-write-handler', `connection ${owner} does not accept writes`)
    }
    return Promise.resolve(handler(point, value))
  }
}

class PointsServiceImpl extends Service {
  constructor(ctx: Context, private readonly core: FieldCore) {
    super(ctx, 'points')
  }

  list(): readonly PointDescriptor[] {
    return [...this.core.connections.values()].flatMap(entry => [...entry.points.values()])
  }

  read(ref: PointRef): PointSample | undefined {
    const owner = this.core.pointIndex.get(pointKey(ref))
    if (owner === undefined) return undefined
    return this.core.connections.get(owner)?.values.get(pointKey(ref))
  }

  subscribe(refs: readonly PointRef[], listener: (sample: PointSample) => void): () => void {
    const watched = new Set(refs.map(pointKey))
    return this.ctx.on('point/updated', sample => {
      if (watched.has(pointKey(sample))) listener(sample)
    })
  }

  write(ref: PointRef, value: Exclude<PointValue, null>): Promise<void> {
    return this.core.write(ref, value)
  }
}

class ConnectionsServiceImpl extends Service {
  constructor(ctx: Context, private readonly core: FieldCore) {
    super(ctx, 'connections')
  }

  list(): readonly ConnectionSnapshot[] {
    return [...this.core.connections.values()].map(entry => ({ ...entry.desc, status: entry.status }))
  }

  subscribeStatus(listener: (frame: ConnectionStatusFrame) => void): () => void {
    return this.ctx.on('connection/status', listener)
  }

  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration {
    return this.core.register(caller, desc)
  }
}

class FieldServiceImpl extends Service {
  constructor(ctx: Context, private readonly core: FieldCore) {
    super(ctx, 'field')
  }

  listDrivers(): readonly DriverInfo[] {
    return [...this.core.drivers.values()].map(entry => entry.info)
  }

  mappings(): MappingDocument {
    return this.core.mappings()
  }

  mappingsChanged(): void {
    this.ctx.emit('field/mappings-changed')
  }

  registerDriver(caller: Context, desc: DriverRegistration): () => void {
    return this.core.registerDriver(caller, desc)
  }
}

/** The field seam plugin: mounts `ctx.points`, `ctx.connections`, and `ctx.field`. */
const fieldPlugin: Plugin.Object<Record<string, never>> = {
  name: 'field',
  apply(ctx: Context): void {
    const core = new FieldCore(ctx)
    new PointsServiceImpl(ctx, core)
    new ConnectionsServiceImpl(ctx, core)
    new FieldServiceImpl(ctx, core)
  },
}

export default fieldPlugin
