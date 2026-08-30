/**
 * The four-quadrant message model: every logical message is classified by
 * "who initiates × request/response", decoupled from the physical channel.
 * Swapping the carrier (in-process, Electron IPC, a future WebSocket) leaves
 * the quadrants unchanged; direction is a property of the message, never
 * inferred from the channel.
 *
 * rpcId discipline: whoever initiates mints; a response always echoes the
 * corresponding request's rpcId and never mints a new id. Pure-push frames
 * mint a fresh id per push; answerable frames (a future approval/question
 * family) reuse one stable id until answered.
 *
 * @module @snap-rail/protocol/rpc
 */

import type { Branded } from '@snap-rail/util'

/** Identifier correlating a request with its response. */
export type RpcId = Branded<string, 'RpcId'>

/** Mint an rpc identifier. Only carriers and frame pumps mint; business code never does. */
export function RpcId(value: string): RpcId {
  return value as RpcId
}

/** ① A client-initiated request: call a host method.
 * @param rpcId - minted by the client.
 * @param method - the method key; also the discriminator handlers dispatch on.
 * @param payload - the business payload, validated per method at the host.
 */
export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** ② The response to a {@link ClientRequest}. Always echoes its rpcId.
 * @param rpcId - echoed from the request; never minted here.
 * @param result - business outcome; methods do not throw business errors.
 */
export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/** ③ A host-initiated request: a push frame (or a future answerable request).
 * @param rpcId - minted by the host frame pump; fresh per push frame.
 * @param method - the frame type.
 * @param payload - the frame payload.
 */
export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

/** ④ The response to a {@link ServerRequest}. Always echoes its rpcId. */
export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

/** Every wire message; narrowed via `switch (message.type)`. */
export type RpcMessage = ClientRequest | ServerResponse | ServerRequest | ClientResponse

/** Business outcome of a method. Transport failures are carrier exceptions; the two layers never mix. */
export type RpcResult<T> = { ok: true, value: T } | { ok: false, error: RpcError }

/** Details required per error code; adding a code = one map row (compile-checked). */
export interface RpcErrorDetailsMap {
  'bad-request': { issues: readonly string[] }
  'not-found': { what: string }
  'conflict': { what: string }
  'unavailable': { what: string }
  'internal': { hint?: string }
}

/** Discriminated error union; `code` discriminates, `details` narrows. */
export type RpcError = { [K in keyof RpcErrorDetailsMap]: { code: K, details: RpcErrorDetailsMap[K] } }[keyof RpcErrorDetailsMap]

/** Narrow request form seen by typed signatures; carriers complete it into a full form. */
export type RpcRequest<P> = { rpcId: RpcId, payload: P }

/** Narrow response form seen by typed signatures. */
export type RpcResponse<T> = { rpcId: RpcId, result: RpcResult<T> }

/**
 * Construct a success result.
 * @param value - the method's return value.
 */
export function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/**
 * Construct a business-error result.
 * @param code - the error code.
 * @param details - code-specific details (required).
 */
export function err<K extends keyof RpcErrorDetailsMap>(
  code: K,
  details: RpcErrorDetailsMap[K],
): { ok: false, error: Extract<RpcError, { code: K }> } {
  return { ok: false, error: { code, details } as Extract<RpcError, { code: K }> }
}

/**
 * Thrown by method handlers to fail with a business error; the gateway
 * converts it into `{ ok: false, error }` on the wire. Carrying it as a
 * throw keeps handler happy paths free of result wrapping.
 */
export class RpcBusinessError extends Error {
  constructor(public readonly error: RpcError) {
    super(`rpc business error: ${error.code}`)
    this.name = 'RpcBusinessError'
  }
}

/**
 * Type guard narrowing an unknown value to {@link RpcError}.
 * @param value - candidate error.
 */
export function isRpcError(value: unknown): value is RpcError {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && 'details' in record
}
