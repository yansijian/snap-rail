/**
 * The frame table base: every push frame (a host-initiated `ServerRequest`)
 * is keyed by its wire frame name in `FrameMap`, the twin of
 * {@link RpcMethodMap} for the host-initiated quadrant. This module holds
 * the OPEN merge base only — every domain's rows live with its owner's
 * contract module (field → `@snap-rail/field` `./wire`, ModbusTCP →
 * `@snap-rail/driver-modbus/contract`, station →
 * `@snap-rail/station-rpc/contract`, production stats →
 * `@snap-rail/production-stats/contract`). A program sees the rows of every
 * contract it imports — the open-world rule.
 *
 * Naming: frames are `domain/event` — kebab-case segments joined by `/` —
 * while methods are `domain.resource.verb` joined by `.`. The first frame
 * segment is the owning domain, the same vocabulary method domains use;
 * `ctx.rpc.claimDomain` guards both.
 *
 * @module @snap-rail/protocol/frames
 */

/** Payload type per frame name; open for declaration merging. */
export interface FrameMap {
  // Domain rows merge in from their owning contract modules.
}

/** Frame names on the wire. */
export type FrameName = keyof FrameMap & string

/** The payload type of a frame, derived from its row. */
export type FramePayload<K extends FrameName> = FrameMap[K]
