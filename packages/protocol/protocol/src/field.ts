/**
 * Field domain types shared by both faces: the wire carries exactly these
 * types (zero DTO layer). `null` value means the point is abnormal — read
 * failed or the source is stale; connection-level failure is the connection
 * status, not a per-point code.
 *
 * @module @snap-rail/protocol/field
 */

import type { Branded } from '@snap-rail/util'

/** Semantic type of a point; the bus-level contract between provider and consumer. */
export type PointType = 'bool' | 'int' | 'float' | 'string'

/** A point value. `int` rides BigInt (lossless int64), `float` rides double, `null` = 点位异常. */
export type PointValue = boolean | bigint | number | string | null

/** Opaque point identifier, unique across the whole point table. */
export type PointId = Branded<string, 'PointId'>

/** Mints a point identifier. */
export function PointId(value: string): PointId {
  return value as PointId
}

/** Opaque connection identifier. */
export type ConnectionId = Branded<string, 'ConnectionId'>

/** Mints a connection identifier. */
export function ConnectionId(value: string): ConnectionId {
  return value as ConnectionId
}

/** Static description of one point in the point table. */
export interface PointDescriptor {
  id: PointId
  /** Owning connection; the write path routes through it. */
  connection: ConnectionId
  type: PointType
}

/** One live reading of a point. */
export interface PointSample {
  id: PointId
  value: PointValue
  /** Epoch milliseconds of the sample. */
  time: number
}

/** Connection lifecycle status; `offline` leaves point reads `null`. */
export type ConnectionStatus = 'online' | 'offline'

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
}

/** Frame payload of `point/updated`. */
export interface PointUpdateFrame {
  id: PointId
  value: PointValue
  time: number
}

/** Frame payload of `connection/status`. */
export interface ConnectionStatusFrame {
  id: ConnectionId
  status: ConnectionStatus
  time: number
}
