/**
 * The field domain's wire contract: method rows merged into the protocol's
 * open `RpcMethodMap`, frame rows into `FrameMap`, and the zod schemas that
 * ride with registration (host) and frame parsing (client). The field seam
 * is the industrial-communication domain on the wire — every driver is a
 * provider beneath it (`field.<driver>.*` is the driver's own sub-namespace,
 * claimed through `ctx.rpc.claimDomain`).
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
  PointValue,
} from './model.ts'
import { pointRefSchema } from './model.ts'

/** The point table: read, subscribe, and write control values. Points are
 * addressed everywhere by the (device, group, name) triple — never an
 * opaque id. */
export interface PointsApi {
  /** List every point currently in the point table. */
  list(payload: {}): Promise<RpcResponse<{ points: readonly PointDescriptor[] }>>
  /** Read current values; unknown triples fail; a registered point with no
   * sample yet reads as a `null`-valued sample (`time` 0). */
  read(payload: { points: readonly PointRef[] }): Promise<RpcResponse<{ samples: readonly PointSample[] }>>
  /** Write a control value to a point (routed to the owning driver). */
  write(payload: { point: PointRef, value: Exclude<PointValue, null> }): Promise<RpcResponse<{ accepted: true }>>
  /** Add one reference per triple to the `field/point-updated` subscription
   * (accumulates); frames flow while any reference remains. */
  subscribe(payload: { points: readonly PointRef[] }): Promise<RpcResponse<{ subscribed: true }>>
  /** Drop one reference per triple; unaddressed triples keep their counts. */
  unsubscribe(payload: { points: readonly PointRef[] }): Promise<RpcResponse<{ unsubscribed: true }>>
}

/** Connections: the device side of the field seam. */
export interface ConnectionsApi {
  /** List connections with live status. */
  list(payload: {}): Promise<RpcResponse<{ connections: readonly ConnectionSnapshot[] }>>
}

/** Driver discovery and the generic mapping view. */
export interface FieldMetaApi {
  /** Every registered driver (identity only; phase 1 has no capability flags). */
  listDrivers(payload: {}): Promise<RpcResponse<{ drivers: readonly DriverInfo[] }>>
  /** The aggregated, dialect-free mapping document across drivers. */
  listMappings(payload: {}): Promise<RpcResponse<{ mappings: MappingDocument }>>
}

/** One registered driver as `field.drivers.list` serves it. */
export interface DriverInfo {
  id: string
  title: string
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'field.points.list': PointsApi['list']
    'field.points.read': PointsApi['read']
    'field.points.write': PointsApi['write']
    'field.points.subscribe': PointsApi['subscribe']
    'field.points.unsubscribe': PointsApi['unsubscribe']
    'field.connections.list': ConnectionsApi['list']
    'field.drivers.list': FieldMetaApi['listDrivers']
    'field.mappings.list': FieldMetaApi['listMappings']
  }

  interface FrameMap {
    /** One point joined the point table. */
    'field/point-added': { point: PointDescriptor }
    /** One point left the point table (the departed address, flat). */
    'field/point-removed': { device: string, group: string, name: string }
    /** One live sample; the host gates this frame by subscription refcounts. */
    'field/point-updated': PointSample
    /** One connection joined (snapshot form). */
    'field/connection-added': { connection: ConnectionSnapshot }
    /** One connection left. */
    'field/connection-removed': { id: ConnectionId }
    /** A connection changed status. */
    'field/connection-status': ConnectionStatusFrame
    /** Any driver's mapping tables changed; consumers re-pull `field.mappings.list`. */
    'field/mappings-changed': Record<string, never>
  }
}

// --- request schemas (ride with host registration) ---

const emptyRequest = z.object({}).strict()

const pointListRequest = z.object({ points: z.array(pointRefSchema).min(1) }).strict()

/** Request schemas for the field domain methods. */
export const fieldRequestSchemas = {
  'field.points.list': emptyRequest,
  'field.points.read': pointListRequest,
  'field.points.write': z.object({
    point: pointRefSchema,
    value: z.union([z.boolean(), z.number(), z.bigint(), z.string()]),
  }).strict(),
  'field.points.subscribe': pointListRequest,
  'field.points.unsubscribe': pointListRequest,
  'field.connections.list': emptyRequest,
  'field.drivers.list': emptyRequest,
  'field.mappings.list': emptyRequest,
} as const

// --- frame payload schemas (for registration records and client parsing) ---

const connectionIdSchema = z.string().min(1)
const statusSchema = z.enum(['online', 'offline'])
const pointValueSchema = z.union([z.boolean(), z.number(), z.bigint(), z.string(), z.null()])

/** Payload schemas for the field domain frames. */
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
  'field/point-updated': z.object({
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
    }).strict(),
  }).strict(),
  'field/connection-removed': z.object({ id: connectionIdSchema }).strict(),
  'field/connection-status': z.object({
    id: connectionIdSchema,
    status: statusSchema,
    time: z.number().nonnegative(),
  }).strict(),
  'field/mappings-changed': z.object({}).strict(),
} as const
