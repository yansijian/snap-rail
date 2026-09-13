/**
 * Single-source wire contracts: one {@link defineContract} declaration per
 * domain yields everything a domain's wire surface needs — the rows that
 * merge into the protocol's open maps (via `interface RpcMethodMap extends
 * MethodRows<typeof contract> {}` in the same module), the request schemas
 * that ride with registration, and the frame payload schemas for
 * registration and client parsing. The hand-written trio (Api interface +
 * merge rows + schema table) said the same thing three times; here it is
 * said once.
 *
 * A row's response value type is declared through the phantom `res` field
 * (the builders lie about it so the type is reachable without a runtime
 * schema); runtime rows carry only `request` and, optionally, `response`.
 *
 * @module @snap-rail/protocol/contract
 */

import type { z } from 'zod'
import type { RpcId, RpcResponse } from './rpc.ts'

/** One method row of a domain contract. */
export interface MethodRow<Req extends z.ZodType = z.ZodType, Res = unknown> {
  /** The request schema — the trust-boundary validation at the host. */
  request: Req
  /** Optional runtime response schema: adds the dispatch-time response
   * self-check and the JSON Schema projection in `rpc.describe`. Absent in
   * most rows: the response value type rides the phantom instead. */
  response?: z.ZodType<Res>
  /** Phantom carrying the declared response value type; never present at
   * runtime — the `method()` builders stamp it on the row's type only. */
  readonly res: Res
}

/**
 * Open one method row: the request schema is mandatory (it is the
 * trust-boundary validator), the response value type is declared through
 * `.ret<T>()` or, with a runtime schema, `.res(schema)`.
 *
 * @param request - the request schema.
 */
export function method<Req extends z.ZodType>(request: Req): {
  /** Declare the response value type without a runtime schema. */
  ret<Res>(): MethodRow<Req, Res>
  /** Declare the response value type and a schema that validates it. */
  res<Res>(response: z.ZodType<Res>): MethodRow<Req, Res>
} {
  return {
    ret<Res>(): MethodRow<Req, Res> {
      return { request } as MethodRow<Req, Res>
    },
    res<Res>(response: z.ZodType<Res>): MethodRow<Req, Res> {
      return { request, response } as MethodRow<Req, Res>
    },
  }
}

/** The runtime shape every domain contract shares (what the gateway serves). */
export interface DomainContract {
  /** The wire domain the contract belongs to (diagnostic metadata). */
  readonly domain: string
  /** Method rows keyed by wire name (`domain.resource.verb`). */
  readonly methods: Readonly<Record<string, MethodRow>>
  /** Frame payload schemas keyed by wire name (`domain/event`). */
  readonly frames: Readonly<Record<string, z.ZodType>>
}

/**
 * Declare one domain's wire surface. Keys are full wire names; every
 * conventional call site passes both tables (`methods: {}` when the domain
 * only pushes frames, `frames: {}` when it only serves methods).
 *
 * @param domain - the wire domain (diagnostic metadata; claims are separate).
 * @param def - the method and frame tables.
 */
export function defineContract<
  const M extends Readonly<Record<string, MethodRow>>,
  const F extends Readonly<Record<string, z.ZodType>>,
>(domain: string, def: { methods: M, frames: F }): { readonly domain: string, readonly methods: M, readonly frames: F } {
  return { domain, methods: def.methods, frames: def.frames }
}

/** The wire method signature one contract row yields (an `RpcMethodMap` row). */
export type WireMethodOf<Row extends MethodRow> = (
  payload: z.output<Row['request']>,
) => Promise<RpcResponse<Row['res']>>

/**
 * The `RpcMethodMap` rows a contract yields. Merge them from the contract's
 * own module so importers of that module see the rows (the open-world rule):
 *
 * ```ts
 * declare module '@snap-rail/protocol' {
 *   interface RpcMethodMap extends MethodRows<typeof pluginsContract> {}
 * }
 * ```
 */
export type MethodRows<C extends DomainContract> = {
  [K in keyof C['methods'] & string]: WireMethodOf<C['methods'][K]>
}

/**
 * The `FrameMap` rows a contract yields (payload = schema output); merged
 * with `interface FrameMap extends FrameRows<typeof contract> {}`.
 */
export type FrameRows<C extends DomainContract> = {
  [K in keyof C['frames'] & string]: z.output<C['frames'][K]>
}

/** One method handler as {@link ContractHandlers} requires: parsed payload
 * in, response value out (business failures throw `RpcBusinessError`). */
export type ContractHandlerOf<Row extends MethodRow> = (
  payload: z.output<Row['request']>,
  rpcId: RpcId,
) => Row['res'] | Promise<Row['res']>

/** The handler table `ctx.rpc.serveContract` requires for one contract,
 * keyed by the same wire names as the contract's method rows. */
export type ContractHandlers<C extends DomainContract> = {
  [K in keyof C['methods'] & string]: ContractHandlerOf<C['methods'][K]>
}
