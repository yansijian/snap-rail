/**
 * The field seam: the live point table. Drivers (providers) register
 * connections and push samples; dashboards, alarms, and agents (consumers)
 * subscribe, read, and write. The seam is protocol-agnostic; the `./rpc`
 * subpath is its gateway bridge.
 *
 * Semantics: a `null` value means the point is abnormal (unreadable or
 * stale); connection-level failure is the connection status. Writes are
 * routed to the owning driver and type-checked against the point's declared
 * semantic type.
 *
 * @module @snap-rail/field
 */

import { Context, Service, type Plugin } from '@snap-rail/cordis'
import {
  ConnectionId,
  PointId,
  type ConnectionDescriptor,
  type ConnectionSnapshot,
  type ConnectionStatus,
  type ConnectionStatusFrame,
  type PointDescriptor,
  type PointSample,
  type PointType,
  type PointValue,
} from '@snap-rail/protocol'

export { ConnectionId, PointId }
export type {
  ConnectionDescriptor, ConnectionSnapshot, ConnectionStatus, ConnectionStatusFrame,
  PointDescriptor, PointSample, PointType, PointValue,
}

/** Failure kinds raised by the field seam (the rpc bridge maps them to wire errors). */
export type FieldErrorKind = 'duplicate-connection' | 'duplicate-point' | 'unknown-point' | 'type-mismatch' | 'no-write-handler'

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
  /** Push one sample; `null` marks the point abnormal. */
  sample(id: PointId, value: PointValue): void
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
  points: Map<PointId, PointDescriptor>
  values: Map<PointId, PointSample>
  writeHandler?: WriteHandler
}

declare module '@snap-rail/cordis' {
  interface Context {
    points: PointsService
    connections: ConnectionsService
  }

  interface Events {
    /** A point entered the point table.
     * @param point - the descriptor now visible. */
    'point/added'(point: PointDescriptor): void
    /** A point left the point table.
     * @param id - the removed point id. */
    'point/removed'(id: PointId): void
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
  }
}

/** Read/subscribe/write surface of the point table. */
export interface PointsService {
  /** Every point currently in the table. */
  list(): readonly PointDescriptor[]
  /** The latest sample of a point, or `undefined` before its first sample. */
  read(id: PointId): PointSample | undefined
  /** Observe updates for a set of points; returns the unsubscribe function. */
  subscribe(ids: readonly PointId[], listener: (sample: PointSample) => void): () => void
  /** Write a control value; routed to the owning driver after type validation. */
  write(id: PointId, value: Exclude<PointValue, null>): Promise<void>
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
  readonly pointIndex = new Map<PointId, ConnectionId>()

  constructor(private readonly ctx: Context) {}

  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration {
    if (this.connections.has(desc.id)) {
      throw new FieldError('duplicate-connection', `connection ${desc.id} is already registered`)
    }
    const entry: ConnectionEntry = { desc, status: 'offline', points: new Map(), values: new Map() }
    this.connections.set(desc.id, entry)
    this.ctx.emit('connection/added', { ...desc, status: entry.status })
    const dispose = () => this.remove(desc.id)
    caller.effect(() => dispose)
    const assertOwned = (id: PointId): PointDescriptor | undefined => {
      const owner = this.pointIndex.get(id)
      if (owner === undefined || owner !== desc.id) return undefined
      return entry.points.get(id)
    }
    return {
      setPoints: points => this.setPoints(entry, points),
      sample: (id, value) => {
        const point = assertOwned(id)
        if (point === undefined) throw new FieldError('unknown-point', `connection ${desc.id} sampled unregistered point ${id}`)
        const sample: PointSample = { id, value, time: Date.now() }
        entry.values.set(id, sample)
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
    const next = new Map(points.map(point => [point.id, point]))
    for (const id of next.keys()) {
      const owner = this.pointIndex.get(id)
      if (owner !== undefined && owner !== entry.desc.id) {
        throw new FieldError('duplicate-point', `point ${id} is already registered by connection ${owner}`)
      }
    }
    for (const id of [...entry.points.keys()]) {
      if (!next.has(id)) {
        entry.points.delete(id)
        entry.values.delete(id)
        this.pointIndex.delete(id)
        this.ctx.emit('point/removed', id)
      }
    }
    for (const [id, point] of next) {
      if (entry.points.has(id)) continue
      entry.points.set(id, point)
      this.pointIndex.set(id, entry.desc.id)
      this.ctx.emit('point/added', point)
    }
  }

  private remove(id: ConnectionId): void {
    const entry = this.connections.get(id)
    if (entry === undefined) return
    for (const pointId of entry.points.keys()) {
      this.pointIndex.delete(pointId)
      this.ctx.emit('point/removed', pointId)
    }
    this.connections.delete(id)
    this.ctx.emit('connection/removed', id)
  }

  write(id: PointId, value: Exclude<PointValue, null>): Promise<void> {
    const owner = this.pointIndex.get(id)
    if (owner === undefined) throw new FieldError('unknown-point', `write to unknown point ${id}`)
    const entry = this.connections.get(owner)
    const point = entry?.points.get(id)
    if (entry === undefined || point === undefined) {
      throw new FieldError('unknown-point', `write to unknown point ${id}`)
    }
    const expected = expectedValueType(point.type)
    if (typeof value !== expected) {
      throw new FieldError('type-mismatch', `point ${id} expects ${point.type} (${expected}), received ${typeof value}`)
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

  read(id: PointId): PointSample | undefined {
    const owner = this.core.pointIndex.get(id)
    if (owner === undefined) return undefined
    return this.core.connections.get(owner)?.values.get(id)
  }

  subscribe(ids: readonly PointId[], listener: (sample: PointSample) => void): () => void {
    const watched = new Set(ids)
    return this.ctx.on('point/updated', sample => {
      if (watched.has(sample.id)) listener(sample)
    })
  }

  write(id: PointId, value: Exclude<PointValue, null>): Promise<void> {
    return this.core.write(id, value)
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

/** The field seam plugin: mounts `ctx.points` and `ctx.connections`. */
const fieldPlugin: Plugin.Object<Record<string, never>> = {
  name: 'field',
  apply(ctx: Context): void {
    const core = new FieldCore(ctx)
    new PointsServiceImpl(ctx, core)
    new ConnectionsServiceImpl(ctx, core)
  },
}

export default fieldPlugin
