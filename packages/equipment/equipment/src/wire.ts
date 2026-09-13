/**
 * The equipment domain's wire contract: method rows merged into the protocol's
 * open `RpcMethodMap`, frame rows into `FrameMap`, and the zod schemas that
 * ride with registration (host) and frame parsing (client). The equipment seam
 * is the industrial-communication domain on the wire — every driver is a
 * provider beneath it; the base owns the configuration tables
 * (`equipment.config.list` + the `equipment.<resource>.<verb>` CRUD) and the live
 * point table (`equipment.points.*`).
 *
 * This module is the merge point: any program that imports `@snap-rail/equipment`
 * sees these rows; consumers elsewhere stay untyped (open-world rule).
 *
 * @module @snap-rail/equipment/wire
 */

import { z } from 'zod'
import { defineContract, method } from '@snap-rail/protocol'
import type { FrameRows, MethodRows } from '@snap-rail/protocol'
import type { MappingDocument } from './mapping.ts'
import type {
  ConnectionSnapshot,
  PointDescriptor,
  PointSample,
  PointType,
} from './model.ts'
import { pointRefSchema } from './model.ts'

/** A dialect config blob as it crosses the wire (driver-defined shape). */
export type DialectConfig = Record<string, unknown>

/** A JSON Schema document projected from a driver's zod schema (form-facing). */
export type DialectSchema = Record<string, unknown>

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

/** One registered driver as `equipment.drivers.list` serves it. */
export interface DriverInfo {
  id: string
  title: string
  /** JSON Schema (input form) of the dialect forms — what the settings page renders. */
  schemas: { device: DialectSchema, point: DialectSchema }
}

// --- shared payload schema fragments ---

const emptyRequest = z.object({}).strict()

const pointListRequest = z.array(pointRefSchema).min(1).readonly()

/** A dialect config blob: any JSON object; the driver's schema is the validator. */
const dialectConfig = z.record(z.string(), z.unknown())

const driverId = z.string().regex(/^[a-z][a-z0-9-]*$/)

/** Device/group/point names: non-empty, no `/` (keeps the triple unambiguous). */
const configName = z.string().min(1).max(128).refine(
  value => !value.includes('/'), 'names must not contain "/"')

const pointValueSchema = z.union([z.boolean(), z.number(), z.bigint(), z.string(), z.null()])
const connectionIdSchema = z.string().min(1)
const statusSchema = z.enum(['connecting', 'online', 'offline'])
const statusMessage = z.string().max(512).optional()

/**
 * The equipment wire surface — one declaration serving the merged protocol
 * rows, the registration schemas, and the client-side frame parsers. The
 * seam owns the configuration tables (`equipment.config.list` + the
 * `equipment.<resource>.<verb>` CRUD) and the live point table
 * (`equipment.points.*`); every driver is a provider beneath it.
 */
export const equipmentContract = defineContract('equipment', {
  methods: {
    /** List every point currently in the point table. */
    'equipment.points.list': method(emptyRequest).ret<{ points: readonly PointDescriptor[] }>(),
    /** Read current values; unknown triples fail; a registered point with no
     * sample yet reads as a `null`-valued sample (`time` 0). */
    'equipment.points.read': method(z.object({ points: pointListRequest }).strict())
      .ret<{ samples: readonly PointSample[] }>(),
    /** Write a control value to a point (routed to the owning driver). */
    'equipment.points.write': method(z.object({
      point: pointRefSchema,
      value: z.union([z.boolean(), z.number(), z.bigint(), z.string()]),
    }).strict()).ret<{ accepted: true }>(),
    /** Add one reference per triple to the `equipment/point-updated` subscription
     * (accumulates); frames flow while any reference remains. */
    'equipment.points.subscribe': method(z.object({ points: pointListRequest }).strict())
      .ret<{ subscribed: true }>(),
    /** Drop one reference per triple; unaddressed triples keep their counts. */
    'equipment.points.unsubscribe': method(z.object({ points: pointListRequest }).strict())
      .ret<{ unsubscribed: true }>(),
    /** List connections with live status. */
    'equipment.connections.list': method(emptyRequest).ret<{ connections: readonly ConnectionSnapshot[] }>(),
    /** The full configuration tree (includes devices whose driver is absent). */
    'equipment.config.list': method(emptyRequest).ret<{ config: ConfigDocument }>(),
    /** Create or update one device; `id` absent means create (the base mints
     * the id from the name). */
    'equipment.devices.upsert': method(z.object({
      device: z.object({
        id: configName.optional(),
        name: configName,
        driver: driverId,
        config: dialectConfig,
      }).strict(),
    }).strict()).ret<{ device: ConfigDevice }>(),
    /** Remove one device. */
    'equipment.devices.remove': method(z.object({ id: configName }).strict()).ret<{ removed: true }>(),
    /** Create or update one group; type is immutable once the group has points. */
    'equipment.groups.upsert': method(z.object({
      device: configName,
      group: z.object({
        name: configName,
        type: z.enum(['bool', 'int', 'float', 'string']),
      }).strict(),
    }).strict()).ret<{ group: ConfigGroup }>(),
    /** Remove one group. */
    'equipment.groups.remove': method(z.object({ device: configName, group: configName }).strict())
      .ret<{ removed: true }>(),
    /** Create or update one point; the point's type comes from its group,
     * the config from the driver's schema. */
    'equipment.points.upsert': method(z.object({
      device: configName,
      group: configName,
      point: z.object({
        name: configName,
        config: dialectConfig,
      }).strict(),
    }).strict()).ret<{ point: ConfigPoint }>(),
    /** Remove one point. */
    'equipment.points.remove': method(z.object({ device: configName, group: configName, name: configName }).strict())
      .ret<{ removed: true }>(),
    /** Every registered driver: identity and the JSON Schema projections of
     * its dialect forms. */
    'equipment.drivers.list': method(emptyRequest).ret<{ drivers: readonly DriverInfo[] }>(),
    /** The aggregated, dialect-free mapping document (live devices only). */
    'equipment.mappings.list': method(emptyRequest).ret<{ mappings: MappingDocument }>(),
  },
  frames: {
    /** One point joined the point table. */
    'equipment/point-added': z.object({
      point: z.object({
        device: z.string().min(1),
        group: z.string().min(1),
        name: z.string().min(1),
        connection: connectionIdSchema,
        type: z.enum(['bool', 'int', 'float', 'string']),
      }).strict(),
    }).strict(),
    /** One point left the point table (the departed address, flat). */
    'equipment/point-removed': z.object({
      device: z.string().min(1),
      group: z.string().min(1),
      name: z.string().min(1),
    }).strict(),
    /** One live sample; the host gates this frame by subscription refcounts. */
    'equipment/point-updated': z.object({
      device: z.string().min(1),
      group: z.string().min(1),
      name: z.string().min(1),
      value: pointValueSchema,
      time: z.number().nonnegative(),
    }).strict(),
    /** One connection joined (snapshot form). */
    'equipment/connection-added': z.object({
      connection: z.object({
        id: connectionIdSchema,
        driver: z.string().min(1),
        title: z.string(),
        status: statusSchema,
        message: statusMessage,
      }).strict(),
    }).strict(),
    /** One connection left. */
    'equipment/connection-removed': z.object({ id: connectionIdSchema }).strict(),
    /** A connection changed status. */
    'equipment/connection-status': z.object({
      id: connectionIdSchema,
      status: statusSchema,
      message: statusMessage,
      time: z.number().nonnegative(),
    }).strict(),
    /** Any driver's mapping tables changed; consumers re-pull `equipment.mappings.list`. */
    'equipment/mappings-changed': z.object({}).strict(),
    /** The base's configuration tables changed (device/group/point CRUD);
     * consumers re-pull `equipment.config.list`. */
    'equipment/structure-changed': z.object({}).strict(),
  },
})

/** Payload schemas for the equipment domain frames — the contract's frame
 * table under its historical name (client-side parsing indexes it). */
export const equipmentFrameSchemas = equipmentContract.frames

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof equipmentContract> {}
  interface FrameMap extends FrameRows<typeof equipmentContract> {}
}
