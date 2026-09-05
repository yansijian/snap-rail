/**
 * The field seam: the device-connection base. It owns the configuration
 * tables (devices/groups/points, `data/field.db`) and the live point table.
 * Drivers register as pure protocol adapters — dialect schemas and a
 * connection factory; the base orchestrates: it computes the
 * desired state from its tables and calls `createConnection`/`update`/
 * `dispose`, while the driver decides how a change lands (hot-apply versus
 * reconnect). Consumers (dashboards, alarms, agents) subscribe, read, and
 * write through triples; the `./rpc` subpath is the gateway bridge.
 *
 * Addressing: a point's address is the (device, group, name) triple — there
 * is no opaque id; the composite `pointKey` exists only as the host-side
 * map key and audit subject. A point's semantic type is its group's type.
 *
 * Semantics: a `null` value means the point is abnormal (unreadable or
 * stale); connection-level failure is the connection status. Writes are
 * routed to the owning driver and type-checked against the point's declared
 * semantic type.
 *
 * @module @snap-rail/field
 */

import { Context, Service, type Plugin } from '@snap-rail/cordis'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { StoreDatabase } from '@snap-rail/store'
import '@snap-rail/store'
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
import { FIELD_SCHEMA, fieldDevices, fieldGroups, fieldPoints } from './schema.ts'
import { fieldFrameSchemas, fieldTopicFilterSchemas, type ConfigDevice, type ConfigGroup, type ConfigPoint, type DialectSchema, type DriverInfo } from './wire.ts'

export { ConnectionId, pointKey, pointRefSchema }
export type {
  ConnectionDescriptor, ConnectionSnapshot, ConnectionStatus, ConnectionStatusFrame,
  PointDescriptor, PointRef, PointSample, PointType, PointValue,
}
export type { MappingDevice, MappingDocument, MappingGroup, MappingPoint }
export * from './wire.ts'

/** Failure kinds raised by the field seam (the rpc bridge maps them to wire errors). */
export type FieldErrorKind =
  | 'duplicate-connection' | 'duplicate-point' | 'duplicate-driver'
  | 'unknown-point' | 'unknown-driver' | 'unknown-device' | 'unknown-group'
  | 'driver-conflict' | 'type-conflict' | 'type-mismatch' | 'invalid-config'
  | 'no-write-handler'

/** A field-seam failure carrying a machine-readable kind. */
export class FieldError extends Error {
  constructor(public readonly kind: FieldErrorKind, message: string) {
    super(`field: ${message}`)
    this.name = 'FieldError'
  }
}

/** Handler receiving writes routed to a driver's connection. */
export type WriteHandler = (point: PointDescriptor, value: Exclude<PointValue, null>) => Promise<void> | void

/** A dialect config blob as drivers and the base pass it around. */
export type DialectConfig = Record<string, unknown>

/** The provider-side handle the base hands a connection: report link state,
 * push samples, accept writes. The point table itself is base-owned — the
 * driver never registers points directly. */
export interface DriverHandle {
  /** Announce link state; `offline` leaves reads to the driver's null samples.
   * A message carries the latest verdict (failure reason). */
  status(status: ConnectionStatus, message?: string): void
  /** Push one sample for the addressed point; `null` marks it abnormal. */
  sample(ref: PointRef, value: PointValue): void
  /** Install the write handler (once); writes before this fail `no-write-handler`. */
  onWrite(handler: WriteHandler): void
}

/** One configured device as its driver sees it. */
export interface DriverDevice {
  /** Stable address identity (part of every point triple). */
  id: string
  /** Human-facing label. */
  name: string
  /** The driver-validated dialect config. */
  config: DialectConfig
}

/** One configured point as its driver sees it: the triple, its type (the
 * group's), and the driver-validated dialect config. */
export interface DriverPoint extends PointRef {
  type: PointType
  config: DialectConfig
}

/** The driver-side controller the base orchestrates. */
export interface DriverConnection {
  /** The device's config or point set changed; the driver decides hot-apply
   * versus reconnect (it knows which fields touch the link). */
  update(device: DriverDevice, points: readonly DriverPoint[]): Promise<void> | void
  /** Tear the connection down (device removed, driver unloaded, base shutting down). */
  dispose(): Promise<void> | void
}

/** The dialect schemas a driver registers: zod objects whose JSON Schema
 * projections drive the base's settings forms. The point schema validates
 * the merged `{ type, ...config }` object — the base supplies `type` from
 * the group; the stored config is the dialect part alone. */
export interface DriverSchemas {
  /** Validates a device's dialect config. */
  device: z.ZodType<DialectConfig>
  /** Validates a point's dialect config with its group type in context. */
  point: z.ZodType<DialectConfig>
}

/** What a driver registers with the field seam. The id doubles as the
 * driver's wire sub-namespace (`field.<id>.*`, claimed by the driver's own
 * rpc module). */
export interface DriverRegistration {
  /** Driver id — lowercase kebab; unique across registered drivers. */
  id: string
  /** Human-facing title served by `field.drivers.list`. */
  title: string
  /** The dialect schemas (validated configs, form projections). */
  schemas: DriverSchemas
  /** Build the connection for a configured device. Called whenever the
   * device (re)enters the desired state under this driver. */
  createConnection: (device: DriverDevice, points: readonly DriverPoint[], handle: DriverHandle) => DriverConnection
}

/** The provider-side handle returned by connection registration. */
export interface ConnectionRegistration {
  /** Replace this connection's point set wholesale; diffed into added/removed events. */
  setPoints(points: readonly PointDescriptor[]): void
  /** Push one sample for the addressed point; `null` marks it abnormal. */
  sample(ref: PointRef, value: PointValue): void
  /** Announce connection status; offline leaves reads to the driver's null samples. */
  setStatus(status: ConnectionStatus, message?: string): void
  /** Install the write handler (once); writes before this fail `no-write-handler`. */
  setWriteHandler(handler: WriteHandler): void
  /** Remove the connection and its points; also runs automatically when the registering fiber unloads. */
  dispose(): void
}

interface ConnectionEntry {
  desc: ConnectionDescriptor
  status: ConnectionStatus
  message?: string
  points: Map<string, PointDescriptor>
  values: Map<string, PointSample>
  writeHandler?: WriteHandler
}

interface DriverEntry {
  info: DriverInfo
  deviceSchema: z.ZodType<DialectConfig>
  pointSchema: z.ZodType<DialectConfig>
  createConnection: DriverRegistration['createConnection']
}

interface ControllerEntry {
  driverId: string
  title: string
  connection: ConnectionRegistration
  controller: DriverConnection
  /** Last state handed to the driver; unchanged states skip `update()`. */
  applied: string
}

declare module '@snap-rail/cordis' {
  interface Context {
    points: PointsService
    connections: ConnectionsService
    field: FieldService
  }
}

/** The gate predicate of the `field/point-update` topic: with a point filter,
 * only samples of the addressed triples match. */
function pointUpdateMatch(filter: { points?: readonly PointRef[] | undefined }, sample: PointSample): boolean {
  return filter.points === undefined || filter.points.some(ref => pointKey(ref) === pointKey(sample))
}

/** Read/write surface of the point table; live updates flow through the
 * `field/point-update` topic. */
export interface PointsService {
  /** Every point currently in the table. */
  list(): readonly PointDescriptor[]
  /** The latest sample of a point, or `undefined` before its first sample. */
  read(ref: PointRef): PointSample | undefined
  /** Write a control value; routed to the owning driver after type validation. */
  write(ref: PointRef, value: Exclude<PointValue, null>): Promise<void>
}

/** Provider/consumer surface of connections; status changes flow through the
 * `field/connection-status` topic. */
export interface ConnectionsService {
  /** Every connection with live status. */
  list(): readonly ConnectionSnapshot[]
  /** Register a connection owned by the caller; disposal rides the caller's fiber.
   * @param caller - the driver plugin's context; unloading it removes the connection.
   * @param desc - the connection descriptor.
   * @returns the provider-side handle.
   */
  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration
}

/** A device upsert as the service takes it (`id` absent = create). */
export interface DeviceUpsert {
  id?: string | undefined
  name: string
  driver: string
  config: DialectConfig
}

/** The field domain's face: the driver registry, the configuration tables,
 * and the generic mapping view. */
export interface FieldService {
  /** Registered drivers in registration order (schemas included). */
  listDrivers(): readonly DriverInfo[]
  /** The full configuration tree, including devices whose driver is absent. */
  config(): { devices: readonly ConfigDevice[] }
  /** The aggregated mapping document across live devices (driver registered). */
  mappings(): MappingDocument
  /** Notify mappings consumers (the rpc bridge rebroadcasts the frame). */
  mappingsChanged(): void
  /** Register a driver; disposal rides the caller's fiber.
   * @param caller - the driver's context; unloading it removes the registration
   * (and the connections it served — configured devices stay, just lifeless).
   */
  registerDriver(caller: Context, desc: DriverRegistration): () => void
  /** Create or update a device (config validated by the driver's schema). */
  upsertDevice(input: DeviceUpsert): ConfigDevice
  /** Remove a device and everything under it. */
  removeDevice(id: string): void
  /** Create a group, or retype it while it has no points. */
  upsertGroup(device: string, group: { name: string, type: PointType }): ConfigGroup
  /** Remove a group and its points. */
  removeGroup(device: string, group: string): void
  /** Create or update a point (config validated by the driver's schema with
   * the group's type in context). */
  upsertPoint(device: string, group: string, point: { name: string, config: DialectConfig }): ConfigPoint
  /** Remove a point. */
  removePoint(ref: PointRef): void
}

function expectedValueType(type: PointType): string {
  switch (type) {
    case 'bool': return 'boolean'
    case 'int': return 'bigint'
    case 'float': return 'number'
    case 'string': return 'string'
  }
}

/** Project a driver's zod schema into the JSON Schema the settings forms
 * render (input form — defaults read as optional; the `$schema` boilerplate
 * is stripped for a clean wire payload). */
function projectSchema(schema: z.ZodType<DialectConfig>): DialectSchema {
  const { $schema, ...projected } = z.toJSONSchema(schema, { io: 'input' }) as DialectSchema & { $schema?: string }
  void $schema
  return projected
}

/** Parse a stored config blob; malformed JSON is a readable field failure
 * (write paths guarantee valid JSON, so this only guards hand-edited files). */
function parseConfig(raw: string): DialectConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new FieldError('invalid-config', `stored config is not valid JSON: ${raw.slice(0, 80)}`)
  }
  return typeof parsed === 'object' && parsed !== null ? parsed as DialectConfig : {}
}

/** Issue text from a failed zod parse. */
function issuesOf(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

interface DeviceRow { id: string, name: string, driverId: string, config: DialectConfig }
interface GroupRow { deviceId: string, name: string, type: PointType }
interface PointRow { deviceId: string, group: string, name: string, config: DialectConfig }

class FieldCore {
  readonly connections = new Map<ConnectionId, ConnectionEntry>()
  /** Composite point key → owning connection id. */
  readonly pointIndex = new Map<string, ConnectionId>()
  readonly drivers = new Map<string, DriverEntry>()
  /** Device id → live controller (device row × registered driver). */
  private readonly controllers = new Map<string, ControllerEntry>()
  private readonly db: StoreDatabase<typeof FIELD_SCHEMA>

  constructor(private readonly ctx: Context) {
    this.db = ctx.store.register(ctx, 'field', FIELD_SCHEMA)
    // The domain's topics are the live table's push face; declared before the
    // first connection can rise, so a publish never beats its declaration.
    ctx.topic.declare(ctx, 'field/point-update', {
      payload: fieldFrameSchemas['field/point-update'],
      filter: fieldTopicFilterSchemas['field/point-update'],
      match: pointUpdateMatch,
    })
    ctx.topic.declare(ctx, 'field/point-added', { payload: fieldFrameSchemas['field/point-added'] })
    ctx.topic.declare(ctx, 'field/point-removed', { payload: fieldFrameSchemas['field/point-removed'] })
    ctx.topic.declare(ctx, 'field/connection-added', { payload: fieldFrameSchemas['field/connection-added'] })
    ctx.topic.declare(ctx, 'field/connection-removed', { payload: fieldFrameSchemas['field/connection-removed'] })
    ctx.topic.declare(ctx, 'field/connection-status', { payload: fieldFrameSchemas['field/connection-status'] })
    ctx.topic.declare(ctx, 'field/mappings-changed', { payload: fieldFrameSchemas['field/mappings-changed'] })
    ctx.topic.declare(ctx, 'field/structure-changed', { payload: fieldFrameSchemas['field/structure-changed'] })
    // Pool-loaded devices meet their drivers later; both events trigger a
    // reconcile, so one here only covers "driver loaded before field" order.
    this.reconcile()
    ctx.effect(() => () => {
      for (const [id, entry] of [...this.controllers]) this.teardown(id, entry)
    })
  }

  // ---- driver registry ----

  registerDriver(caller: Context, desc: DriverRegistration): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(desc.id) || desc.title.trim() === '') {
      throw new FieldError('duplicate-driver', `invalid driver registration (id "${desc.id}", title "${desc.title}")`)
    }
    const entry: DriverEntry = {
      info: {
        id: desc.id,
        title: desc.title,
        schemas: {
          device: projectSchema(desc.schemas.device),
          point: projectSchema(desc.schemas.point),
        },
      },
      deviceSchema: desc.schemas.device,
      pointSchema: desc.schemas.point,
      createConnection: desc.createConnection,
    }
    // A same-id registration replaces (hot-reload semantics): the old
    // controllers die first, the new ones rise in the reconcile below.
    for (const [id, controller] of [...this.controllers]) {
      if (controller.driverId === desc.id) this.teardown(id, controller)
    }
    this.drivers.set(desc.id, entry)
    this.reconcile()
    const dispose = (): void => {
      if (this.drivers.get(desc.id) !== entry) return
      this.drivers.delete(desc.id)
      for (const [id, controller] of [...this.controllers]) {
        if (controller.driverId === desc.id) this.teardown(id, controller)
      }
    }
    caller.effect(() => dispose)
    return dispose
  }

  // ---- configuration tables ----

  private readRows(): { devices: DeviceRow[], groups: GroupRow[], points: PointRow[] } {
    const devices = this.db.select().from(fieldDevices).orderBy(fieldDevices.id).all()
      .map(row => ({ id: row.id, name: row.name, driverId: row.driverId, config: parseConfig(row.config) }))
    const groups = this.db.select().from(fieldGroups).orderBy(fieldGroups.deviceId, fieldGroups.name).all()
      .map(row => ({ deviceId: row.deviceId, name: row.name, type: row.type as PointType }))
    const points = this.db.select().from(fieldPoints).orderBy(fieldPoints.deviceId, fieldPoints.group, fieldPoints.name).all()
      .map(row => ({ deviceId: row.deviceId, group: row.group, name: row.name, config: parseConfig(row.config) }))
    return { devices, groups, points }
  }

  private deviceById(id: string, rows = this.readRows()): DeviceRow | undefined {
    return rows.devices.find(row => row.id === id)
  }

  /** The device's points as its driver sees them (group types in context). */
  private driverPointsOf(device: DeviceRow, rows: { groups: GroupRow[], points: PointRow[] }): DriverPoint[] {
    const types = new Map(rows.groups.filter(g => g.deviceId === device.id).map(g => [g.name, g.type]))
    return rows.points
      .filter(point => point.deviceId === device.id)
      .map(point => ({
        device: point.deviceId,
        group: point.group,
        name: point.name,
        type: types.get(point.group) ?? 'string',
        config: point.config,
      }))
  }

  config(): { devices: readonly ConfigDevice[] } {
    const rows = this.readRows()
    return {
      devices: rows.devices.map((device): ConfigDevice => ({
        id: device.id,
        name: device.name,
        driver: device.driverId,
        config: device.config,
        groups: this.configGroupsOf(device, rows),
      })),
    }
  }

  private configGroupsOf(device: DeviceRow, rows: { groups: GroupRow[], points: PointRow[] }): ConfigGroup[] {
    return rows.groups
      .filter(group => group.deviceId === device.id)
      .map((group): ConfigGroup => ({
        name: group.name,
        type: group.type,
        points: rows.points
          .filter(point => point.deviceId === device.id && point.group === group.name)
          .map(point => ({ name: point.name, config: point.config })),
      }))
  }

  private configDeviceOf(id: string): ConfigDevice {
    const rows = this.readRows()
    const device = this.deviceById(id, rows)
    if (device === undefined) throw new FieldError('unknown-device', `device "${id}" vanished mid-mutation`)
    return {
      id: device.id,
      name: device.name,
      driver: device.driverId,
      config: device.config,
      groups: this.configGroupsOf(device, rows),
    }
  }

  private configGroupOf(device: string, group: string): ConfigGroup {
    const rows = this.readRows()
    const row = rows.groups.find(candidate => candidate.deviceId === device && candidate.name === group)
    if (row === undefined) throw new FieldError('unknown-group', `group "${group}" vanished mid-mutation`)
    return {
      name: row.name,
      type: row.type,
      points: rows.points
        .filter(point => point.deviceId === device && point.group === group)
        .map(point => ({ name: point.name, config: point.config })),
    }
  }

  private mintDeviceId(name: string): string {
    const taken = new Set(this.db.select({ id: fieldDevices.id }).from(fieldDevices).all().map(row => row.id))
    if (!taken.has(name)) return name
    for (let suffix = 2; ; suffix++) {
      const candidate = `${name}-${suffix}`
      if (!taken.has(candidate)) return candidate
    }
  }

  /** Mutations land, then the desired state is recomputed and consumers notified. */
  private afterMutation(): void {
    this.reconcile()
    this.ctx.topic.publish('field/structure-changed', {})
    this.ctx.topic.publish('field/mappings-changed', {})
  }

  upsertDevice(input: DeviceUpsert): ConfigDevice {
    const driver = this.drivers.get(input.driver)
    if (driver === undefined) {
      throw new FieldError('unknown-driver', `driver "${input.driver}" is not registered`)
    }
    const parsed = driver.deviceSchema.safeParse(input.config)
    if (!parsed.success) {
      throw new FieldError('invalid-config', `device config rejected by driver "${input.driver}": ${issuesOf(parsed.error)}`)
    }
    const config = JSON.stringify(parsed.data)
    if (input.id === undefined) {
      const id = this.mintDeviceId(input.name)
      this.db.insert(fieldDevices).values({ id, name: input.name, driverId: input.driver, config }).run()
      this.afterMutation()
      return this.configDeviceOf(id)
    }
    const existing = this.db.select().from(fieldDevices).where(eq(fieldDevices.id, input.id)).get()
    if (existing === undefined) {
      throw new FieldError('unknown-device', `device "${input.id}" does not exist`)
    }
    if (existing.driverId !== input.driver) {
      throw new FieldError('driver-conflict', `device "${input.id}" belongs to driver "${existing.driverId}"`)
    }
    this.db.update(fieldDevices).set({ name: input.name, config }).where(eq(fieldDevices.id, input.id)).run()
    this.afterMutation()
    return this.configDeviceOf(input.id)
  }

  removeDevice(id: string): void {
    const existing = this.db.select({ id: fieldDevices.id }).from(fieldDevices).where(eq(fieldDevices.id, id)).get()
    if (existing === undefined) {
      throw new FieldError('unknown-device', `device "${id}" does not exist`)
    }
    this.db.transaction(tx => {
      tx.delete(fieldPoints).where(eq(fieldPoints.deviceId, id)).run()
      tx.delete(fieldGroups).where(eq(fieldGroups.deviceId, id)).run()
      tx.delete(fieldDevices).where(eq(fieldDevices.id, id)).run()
    })
    this.afterMutation()
  }

  upsertGroup(device: string, group: { name: string, type: PointType }): ConfigGroup {
    const owner = this.db.select({ id: fieldDevices.id }).from(fieldDevices).where(eq(fieldDevices.id, device)).get()
    if (owner === undefined) {
      throw new FieldError('unknown-device', `device "${device}" does not exist`)
    }
    const existing = this.db.select().from(fieldGroups)
      .where(and(eq(fieldGroups.deviceId, device), eq(fieldGroups.name, group.name))).get()
    if (existing === undefined) {
      this.db.insert(fieldGroups).values({ deviceId: device, name: group.name, type: group.type }).run()
    } else if (existing.type !== group.type) {
      const members = this.db.select({ name: fieldPoints.name }).from(fieldPoints)
        .where(and(eq(fieldPoints.deviceId, device), eq(fieldPoints.group, group.name))).all()
      if (members.length > 0) {
        throw new FieldError('type-conflict', `group "${device}/${group.name}" still has points; retype means remove + recreate`)
      }
      this.db.update(fieldGroups).set({ type: group.type })
        .where(and(eq(fieldGroups.deviceId, device), eq(fieldGroups.name, group.name))).run()
    }
    this.afterMutation()
    return this.configGroupOf(device, group.name)
  }

  removeGroup(device: string, group: string): void {
    const existing = this.db.select().from(fieldGroups)
      .where(and(eq(fieldGroups.deviceId, device), eq(fieldGroups.name, group))).get()
    if (existing === undefined) {
      throw new FieldError('unknown-group', `group "${device}/${group}" does not exist`)
    }
    this.db.transaction(tx => {
      tx.delete(fieldPoints)
        .where(and(eq(fieldPoints.deviceId, device), eq(fieldPoints.group, group))).run()
      tx.delete(fieldGroups)
        .where(and(eq(fieldGroups.deviceId, device), eq(fieldGroups.name, group))).run()
    })
    this.afterMutation()
  }

  upsertPoint(device: string, group: string, point: { name: string, config: DialectConfig }): ConfigPoint {
    const owner = this.db.select().from(fieldDevices).where(eq(fieldDevices.id, device)).get()
    if (owner === undefined) {
      throw new FieldError('unknown-device', `device "${device}" does not exist`)
    }
    const groupRow = this.db.select().from(fieldGroups)
      .where(and(eq(fieldGroups.deviceId, device), eq(fieldGroups.name, group))).get()
    if (groupRow === undefined) {
      throw new FieldError('unknown-group', `group "${device}/${group}" does not exist; create the group first`)
    }
    const driver = this.drivers.get(owner.driverId)
    if (driver === undefined) {
      throw new FieldError('unknown-driver', `driver "${owner.driverId}" is not registered`)
    }
    const parsed = driver.pointSchema.safeParse({ type: groupRow.type, ...point.config })
    if (!parsed.success) {
      throw new FieldError('invalid-config', `point config rejected by driver "${owner.driverId}": ${issuesOf(parsed.error)}`)
    }
    const { type: _type, ...dialect } = parsed.data
    const config = JSON.stringify(dialect)
    const existing = this.db.select().from(fieldPoints)
      .where(and(
        eq(fieldPoints.deviceId, device),
        eq(fieldPoints.group, group),
        eq(fieldPoints.name, point.name),
      )).get()
    if (existing === undefined) {
      this.db.insert(fieldPoints).values({ deviceId: device, group, name: point.name, config }).run()
    } else {
      this.db.update(fieldPoints).set({ config })
        .where(and(
          eq(fieldPoints.deviceId, device),
          eq(fieldPoints.group, group),
          eq(fieldPoints.name, point.name),
        )).run()
    }
    this.afterMutation()
    return { name: point.name, config: dialect }
  }

  removePoint(ref: PointRef): void {
    const existing = this.db.select({ name: fieldPoints.name }).from(fieldPoints)
      .where(and(
        eq(fieldPoints.deviceId, ref.device),
        eq(fieldPoints.group, ref.group),
        eq(fieldPoints.name, ref.name),
      )).get()
    if (existing === undefined) {
      throw new FieldError('unknown-point', `point ${pointKey(ref)} does not exist`)
    }
    this.db.delete(fieldPoints)
      .where(and(
        eq(fieldPoints.deviceId, ref.device),
        eq(fieldPoints.group, ref.group),
        eq(fieldPoints.name, ref.name),
      )).run()
    this.afterMutation()
  }

  // ---- the mapping view ----

  mappings(): MappingDocument {
    const rows = this.readRows()
    const devices: MappingDevice[] = []
    const groups: MappingGroup[] = []
    const points: MappingPoint[] = []
    const live = new Set<string>()
    for (const device of rows.devices) {
      if (!this.drivers.has(device.driverId)) continue
      live.add(device.id)
      devices.push({ id: device.id, driver: device.driverId })
    }
    for (const group of rows.groups) {
      if (!live.has(group.deviceId)) continue
      groups.push({ deviceId: group.deviceId, name: group.name, type: group.type })
    }
    for (const point of rows.points) {
      if (!live.has(point.deviceId)) continue
      points.push({ deviceId: point.deviceId, group: point.group, name: point.name })
    }
    return { devices, groups, points }
  }

  // ---- orchestration: tables × drivers → live connections ----

  private reconcile(): void {
    const rows = this.readRows()
    const byId = new Map(rows.devices.map(device => [device.id, device]))

    // Controllers whose device (or its driver) vanished die first.
    for (const [id, entry] of [...this.controllers]) {
      const row = byId.get(id)
      if (row === undefined || !this.drivers.has(row.driverId)) {
        this.teardown(id, entry)
        continue
      }
      // Driver swap never happens in place (driver-conflict), but a rename
      // must rebuild: the connection descriptor is immutable.
      if (entry.driverId !== row.driverId || entry.title !== row.name) {
        this.teardown(id, entry)
      }
    }

    for (const row of rows.devices) {
      const driver = this.drivers.get(row.driverId)
      if (driver === undefined) continue
      const points = this.driverPointsOf(row, rows)
      const device = { id: row.id, name: row.name, config: row.config }
      const applied = JSON.stringify([device, points])
      const descriptors = points.map((point): PointDescriptor => ({
        device: point.device,
        group: point.group,
        name: point.name,
        type: point.type,
        connection: ConnectionId(row.id),
      }))
      const existing = this.controllers.get(row.id)
      if (existing === undefined) {
        const connection = this.ctx.connections.register(this.ctx, {
          id: ConnectionId(row.id),
          driver: row.driverId,
          title: row.name,
        })
        // The live table reflects the configuration immediately; the driver's
        // first samples follow whenever its link comes up.
        connection.setPoints(descriptors)
        const handle: DriverHandle = {
          status: (status, message) => connection.setStatus(status, message),
          sample: (ref, value) => connection.sample(ref, value),
          onWrite: handler => connection.setWriteHandler(handler),
        }
        let controller: DriverConnection
        try {
          controller = driver.createConnection(device, points, handle)
        } catch (cause) {
          // A driver refusing the desired state (a stored config its schema
          // no longer accepts) must not take the mutation — or the whole
          // plugin load — with it: park the device lifeless with the reason
          // on its connection line; the next reconcile retries.
          const reason = cause instanceof Error ? cause.message : String(cause)
          connection.setStatus('offline', `驱动连接创建失败：${reason}`)
          this.ctx.logger.error('field: driver connection failed for %s', row.id, cause)
          connection.dispose()
          continue
        }
        this.controllers.set(row.id, { driverId: row.driverId, title: row.name, connection, controller, applied })
        continue
      }
      existing.connection.setPoints(descriptors)
      if (existing.applied !== applied) {
        existing.applied = applied
        // The microtask hop turns a synchronous throw from `update` into a
        // rejection this catch absorbs; calling it directly would let the
        // throw escape reconcile into the triggering RPC as `internal`.
        void Promise.resolve().then(() => existing.controller.update(device, points)).catch(cause => {
          this.ctx.logger.error('field: driver connection update failed for %s', row.id, cause)
        })
      }
    }
  }

  private teardown(id: string, entry: ControllerEntry): void {
    this.controllers.delete(id)
    void Promise.resolve(entry.controller.dispose()).catch(() => undefined)
    entry.connection.dispose()
  }

  // ---- the live connection registry (internal) ----

  register(caller: Context, desc: ConnectionDescriptor): ConnectionRegistration {
    if (this.connections.has(desc.id)) {
      throw new FieldError('duplicate-connection', `connection ${desc.id} is already registered`)
    }
    const entry: ConnectionEntry = { desc, status: 'connecting', points: new Map(), values: new Map() }
    this.connections.set(desc.id, entry)
    this.ctx.topic.publish('field/connection-added', { connection: { ...desc, status: entry.status } })
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
        this.ctx.topic.publish('field/point-update', sample)
      },
      setStatus: (status, message) => {
        if (entry.status === status && entry.message === message) return
        entry.status = status
        if (message === undefined) delete entry.message
        else entry.message = message
        this.ctx.topic.publish('field/connection-status', {
          id: desc.id,
          status,
          ...(message !== undefined ? { message } : {}),
          time: Date.now(),
        })
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
        this.ctx.topic.publish('field/point-removed', { device: point.device, group: point.group, name: point.name })
      }
    }
    for (const [key, point] of next) {
      if (entry.points.has(key)) continue
      entry.points.set(key, point)
      this.pointIndex.set(key, entry.desc.id)
      this.ctx.topic.publish('field/point-added', { point })
    }
  }

  private remove(id: ConnectionId): void {
    const entry = this.connections.get(id)
    if (entry === undefined) return
    for (const [key, point] of entry.points) {
      this.pointIndex.delete(key)
      this.ctx.topic.publish('field/point-removed', { device: point.device, group: point.group, name: point.name })
    }
    this.connections.delete(id)
    this.ctx.topic.publish('field/connection-removed', { id })
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

  write(ref: PointRef, value: Exclude<PointValue, null>): Promise<void> {
    return this.core.write(ref, value)
  }
}

class ConnectionsServiceImpl extends Service {
  constructor(ctx: Context, private readonly core: FieldCore) {
    super(ctx, 'connections')
  }

  list(): readonly ConnectionSnapshot[] {
    return [...this.core.connections.values()].map(entry => ({
      ...entry.desc,
      status: entry.status,
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    }))
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

  config(): { devices: readonly ConfigDevice[] } {
    return this.core.config()
  }

  mappings(): MappingDocument {
    return this.core.mappings()
  }

  mappingsChanged(): void {
    this.ctx.topic.publish('field/mappings-changed', {})
  }

  registerDriver(caller: Context, desc: DriverRegistration): () => void {
    return this.core.registerDriver(caller, desc)
  }

  upsertDevice(input: DeviceUpsert): ConfigDevice {
    return this.core.upsertDevice(input)
  }

  removeDevice(id: string): void {
    this.core.removeDevice(id)
  }

  upsertGroup(device: string, group: { name: string, type: PointType }): ConfigGroup {
    return this.core.upsertGroup(device, group)
  }

  removeGroup(device: string, group: string): void {
    this.core.removeGroup(device, group)
  }

  upsertPoint(device: string, group: string, point: { name: string, config: DialectConfig }): ConfigPoint {
    return this.core.upsertPoint(device, group, point)
  }

  removePoint(ref: PointRef): void {
    this.core.removePoint(ref)
  }

}

/** The field seam plugin: mounts `ctx.points`, `ctx.connections`, and `ctx.field`. */
const fieldPlugin: Plugin.Object<Record<string, never>> = {
  name: 'field',
  inject: ['store', 'topic'],
  apply(ctx: Context): void {
    const core = new FieldCore(ctx)
    new PointsServiceImpl(ctx, core)
    new ConnectionsServiceImpl(ctx, core)
    new FieldServiceImpl(ctx, core)
  },
}

export default fieldPlugin
