/**
 * Field domain types shared by both faces: the wire carries exactly these
 * types (zero DTO layer). `null` value means the point is abnormal — read
 * failed or the source is stale; connection-level failure is the connection
 * status, not a per-point code.
 *
 * @module @snap-rail/field/model
 */

import { z } from 'zod'
import type { Branded } from '@snap-rail/util'

/** Semantic type of a point; the bus-level contract between provider and consumer. */
export type PointType = 'bool' | 'int' | 'float' | 'string'

/** A point value. `int` rides BigInt (lossless int64), `float` rides double, `null` = 点位异常. */
export type PointValue = boolean | bigint | number | string | null

/**
 * A point's address: device, group, and name. Point names are unique only
 * within their group, so the full triple is the address — the wire never
 * carries an opaque id. Every part is non-empty and free of `/` (the wire
 * schemas enforce this at the trust boundary) so the composite key below
 * stays unambiguous.
 */
export interface PointRef {
  device: string
  group: string
  name: string
}

/**
 * The composite host-side key of a point's triple (`device/group/name`).
 * Map keys and audit subjects only — never a wire form; consumers and
 * providers address each other in triples.
 */
export function pointKey(ref: Readonly<PointRef>): string {
  return `${ref.device}/${ref.group}/${ref.name}`
}

/** Opaque connection identifier. */
export type ConnectionId = Branded<string, 'ConnectionId'>

/** Mints a connection identifier. */
export function ConnectionId(value: string): ConnectionId {
  return value as ConnectionId
}

/** Static description of one point in the point table. */
export interface PointDescriptor {
  /** The point's address; `device` is the business device id. */
  device: string
  group: string
  name: string
  /** Owning connection (the provider that routes writes); for ModbusTCP it
   * is the device id, but the two are distinct vocabularies. */
  connection: ConnectionId
  type: PointType
}

/** One live reading of a point, addressed by its triple. */
export interface PointSample {
  device: string
  group: string
  name: string
  value: PointValue
  /** Epoch milliseconds of the sample. */
  time: number
}

/** Connection lifecycle status: `connecting` until the driver's first verdict,
 * `offline` leaves point reads `null`. */
export type ConnectionStatus = 'connecting' | 'online' | 'offline'

/** Static description of one connection. */
export interface ConnectionDescriptor {
  id: ConnectionId
  /** Driver plugin id that owns this connection. */
  driver: string
  /** Human-facing label for lists. */
  title: string
}

/** A connection plus its live status, as consumers see it. */
export interface ConnectionSnapshot extends ConnectionDescriptor {
  status: ConnectionStatus
  /** Last driver verdict on the link, when it carried one (failure reason). */
  message?: string
}

/** Payload of the `field/connection-status` frame. */
export interface ConnectionStatusFrame {
  id: ConnectionId
  status: ConnectionStatus
  message?: string
  time: number
}

/** One address part: non-empty and free of `/` so the composite host-side
 * key stays unambiguous. */
const addressPart = z.string().min(1).max(128).refine(
  value => !value.includes('/'), 'address parts must not contain "/"')

/** The point address triple; validated whole wherever a point crosses the wire. */
export const pointRefSchema = z.object({
  device: addressPart,
  group: addressPart,
  name: addressPart,
}).strict() satisfies z.ZodType<PointRef>
