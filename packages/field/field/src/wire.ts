/**
 * The field domain's wire contract: method rows merged into the protocol's
 * open `RpcMethodMap`, topic payload rows into `FrameMap`, and the zod
 * schemas that ride with registration (host) and payload parsing (client).
 * The live-table push face rides the gateway's topic primitive — the base
 * declares and publishes `field/*` topics; consumers subscribe through
 * `subscribeTopic` with the schemas here. The field seam is the
 * industrial-communication domain on the wire — every driver is a provider
 * beneath it; the base owns the configuration tables (`field.config.list` +
 * the `field.<resource>.<verb>` CRUD) and the live point table
 * (`field.points.*`).
 *
 * This module is the merge point: any program that imports `@snap-rail/field`
 * sees these rows; consumers elsewhere stay untyped (open-world rule).
 *
 * @module @snap-rail/field/wire
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'
import type { MappingDocument } from './mapping.ts'
import type {
  ConnectionId,
  ConnectionSnapshot,
  ConnectionStatusFrame,
  PointDescriptor,
  PointRef,
  PointSample,
  PointType,
  PointValue,
} from './model.ts'
import { pointRefSchema } from './model.ts'

/** A dialect config blob as it crosses the wire (driver-defined shape). */
export type DialectConfig = Record<string, unknown>

/** A JSON Schema document projected from a driver's zod schema (form-facing). */
export type DialectSchema = Record<string, unknown>

/** The point table: read and write control values. Points are addressed
 * everywhere by the (device, group, name) triple — never an opaque id. Live
 * updates flow through the `field/point-update` topic. */
export interface PointsApi {
  /** List every point currently in the point table. */
  list(payload: {}): Promise<RpcResponse<{ points: readonly PointDescriptor[] }>>
  /** Read current values; unknown triples fail; a registered point with no
   * sample yet reads as a `null`-valued sample (`time` 0). */
  read(payload: { points: readonly PointRef[] }): Promise<RpcResponse<{ samples: readonly PointSample[] }>>
  /** Write a control value to a point (routed to the owning driver). */
  write(payload: { point: PointRef, value: Exclude<PointValue, null> }): Promise<RpcResponse<{ accepted: true }>>
}

/** Connections: the device side of the field seam. */
export interface ConnectionsApi {
  /** List connections with live status. */
  list(payload: {}): Promise<RpcResponse<{ connections: readonly ConnectionSnapshot[] }>>
}

/** One configured point in the configuration tree. */
export interface ConfigPoint {
  name: string
  config: DialectConfig
}

/** One configured group; its type is the semantic type of every member. */
export interface ConfigGroup {
  name: string
  type: PointType
  points: readonly ConfigPoint[]
}

/** One configured device: base identity, dialect config, and its tree. */
export interface ConfigDevice {
  id: string
  name: string
  driver: string
  config: DialectConfig
  groups: readonly ConfigGroup[]
}

/** The whole point-table configuration, one call for the settings page. */
export interface ConfigDocument {
  devices: readonly ConfigDevice[]
}

/** The configuration face: the base-owned device/group/point tables. */
export interface ConfigApi {
  /** The full configuration tree (includes devices whose driver is absent). */
  list(payload: {}): Promise<RpcResponse<{ config: ConfigDocument }>>
}

/** Device CRUD; `id` absent means create (the base mints the id from the name). */
export interface DevicesApi {
  upsert(payload: { device: { id?: string, name: string, driver: string, config: DialectConfig } }): Promise<RpcResponse<{ device: ConfigDevice }>>
  remove(payload: { id: string }): Promise<RpcResponse<{ removed: true }>>
}

/** Group CRUD; type is immutable once the group has points. */
export interface GroupsApi {
  upsert(payload: { device: string, group: { name: string, type: PointType } }): Promise<RpcResponse<{ group: ConfigGroup }>>
  remove(payload: { device: string, group: string }): Promise<RpcResponse<{ removed: true }>>
}

/** Point CRUD; the point's type comes from its group, the config from the driver's schema. */
export interface PointConfigApi {
  upsert(payload: { device: string, group: string, point: { name: string, config: DialectConfig } }): Promise<RpcResponse<{ point: ConfigPoint }>>
  remove(payload: { device: string, group: string, name: string }): Promise<RpcResponse<{ removed: true }>>
}

/** Driver discovery and the generic mapping view. */
export interface FieldMetaApi {
  /** Every registered driver: identity and the JSON Schema projections of
   * its dialect forms. */
  listDrivers(payload: {}): Promise<RpcResponse<{ drivers: readonly DriverInfo[] }>>
  /** The aggregated, dialect-free mapping document (live devices only). */
  listMappings(payload: {}): Promise<RpcResponse<{ mappings: MappingDocument }>>
}

/** One registered driver as `field.drivers.list` serves it. */
export interface DriverInfo {
  id: string
  title: string
  /** JSON Schema (input form) of the dialect forms — what the settings page renders. */
  schemas: { device: DialectSchema, point: DialectSchema }
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'field.points.list': PointsApi['list']
    'field.points.read': PointsApi['read']
    'field.points.write': PointsApi['write']
    'field.connections.list': ConnectionsApi['list']
    'field.config.list': ConfigApi['list']
    'field.devices.upsert': DevicesApi['upsert']
    'field.devices.remove': DevicesApi['remove']
    'field.groups.upsert': GroupsApi['upsert']
    'field.groups.remove': GroupsApi['remove']
    'field.points.upsert': PointConfigApi['upsert']
    'field.points.remove': PointConfigApi['remove']
    'field.drivers.list': FieldMetaApi['listDrivers']
    'field.mappings.list': FieldMetaApi['listMappings']
  }

  interface FrameMap {
    /** One point joined the point table. */
    'field/point-added': { point: PointDescriptor }
    /** One point left the point table (the departed address, flat). */
    'field/point-removed': { device: string, group: string, name: string }
    /** One live sample; the host gates this topic by subscription filters. */
    'field/point-update': PointSample
    /** One connection joined (snapshot form). */
    'field/connection-added': { connection: ConnectionSnapshot }
    /** One connection left. */
    'field/connection-removed': { id: ConnectionId }
    /** A connection changed status. */
    'field/connection-status': ConnectionStatusFrame
    /** Any driver's mapping tables changed; consumers re-pull `field.mappings.list`. */
    'field/mappings-changed': Record<string, never>
    /** The base's configuration tables changed (device/group/point CRUD);
     * consumers re-pull `field.config.list`. */
    'field/structure-changed': Record<string, never>
  }
}

// --- request schemas (ride with host registration) ---

const emptyRequest = z.object({}).strict()

const pointListRequest = z.object({ points: z.array(pointRefSchema).min(1) }).strict()

/** A dialect config blob: any JSON object; the driver's schema is the validator. */
const dialectConfig = z.record(z.string(), z.unknown())

const driverId = z.string().regex(/^[a-z][a-z0-9-]*$/)

/** Device/group/point names: non-empty, no `/` (keeps the triple unambiguous). */
const configName = z.string().min(1).max(128).refine(
  value => !value.includes('/'), 'names must not contain "/"')

/** Request schemas for the field domain methods. */
export const fieldRequestSchemas = {
  'field.points.list': emptyRequest,
  'field.points.read': pointListRequest,
  'field.points.write': z.object({
    point: pointRefSchema,
    value: z.union([z.boolean(), z.number(), z.bigint(), z.string()]),
  }).strict(),
  'field.connections.list': emptyRequest,
  'field.config.list': emptyRequest,
  'field.devices.upsert': z.object({
    device: z.object({
      id: configName.optional(),
      name: configName,
      driver: driverId,
      config: dialectConfig,
    }).strict(),
  }).strict(),
  'field.devices.remove': z.object({ id: configName }).strict(),
  'field.groups.upsert': z.object({
    device: configName,
    group: z.object({
      name: configName,
      type: z.enum(['bool', 'int', 'float', 'string']),
    }).strict(),
  }).strict(),
  'field.groups.remove': z.object({ device: configName, group: configName }).strict(),
  'field.points.upsert': z.object({
    device: configName,
    group: configName,
    point: z.object({
      name: configName,
      config: dialectConfig,
    }).strict(),
  }).strict(),
  'field.points.remove': z.object({ device: configName, group: configName, name: configName }).strict(),
  'field.drivers.list': emptyRequest,
  'field.mappings.list': emptyRequest,
} as const

// --- topic payload schemas (for declarations and client parsing) ---

const connectionIdSchema = z.string().min(1)
const statusSchema = z.enum(['connecting', 'online', 'offline'])
const pointValueSchema = z.union([z.boolean(), z.number(), z.bigint(), z.string(), z.null()])
const statusMessage = z.string().max(512).optional()

/** Payload schemas for the field domain topics (the push face of the live table). */
export const fieldFrameSchemas = {
  'field/point-added': z.object({
    point: z.object({
      device: z.string().min(1),
      group: z.string().min(1),
      name: z.string().min(1),
      connection: connectionIdSchema,
      type: z.enum(['bool', 'int', 'float', 'string']),
    }).strict(),
  }).strict(),
  'field/point-removed': z.object({
    device: z.string().min(1),
    group: z.string().min(1),
    name: z.string().min(1),
  }).strict(),
  'field/point-update': z.object({
    device: z.string().min(1),
    group: z.string().min(1),
    name: z.string().min(1),
    value: pointValueSchema,
    time: z.number().nonnegative(),
  }).strict(),
  'field/connection-added': z.object({
    connection: z.object({
      id: connectionIdSchema,
      driver: z.string().min(1),
      title: z.string(),
      status: statusSchema,
      message: statusMessage,
    }).strict(),
  }).strict(),
  'field/connection-removed': z.object({ id: connectionIdSchema }).strict(),
  'field/connection-status': z.object({
    id: connectionIdSchema,
    status: statusSchema,
    message: statusMessage,
    time: z.number().nonnegative(),
  }).strict(),
  'field/mappings-changed': z.object({}).strict(),
  'field/structure-changed': z.object({}).strict(),
} as const

/** Subscription-filter schemas for the topics that take one (a topic absent
 * here takes no filter). */
export const fieldTopicFilterSchemas = {
  'field/point-update': z.object({ points: z.array(pointRefSchema).optional() }).strict(),
} as const
