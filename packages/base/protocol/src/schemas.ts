/**
 * Envelope validation at the trust boundary: the type/rpcId/method
 * structure of every inbound message. Per-method payload schemas travel
 * with each registration (`ctx.rpc.method`) — there is no central method
 * table. Host responses are produced by trusted code and are not
 * re-validated in phase 1.
 *
 * @module @snap-rail/protocol/schemas
 */

import { z } from 'zod'
import { RpcId, type ClientRequest, type RpcId as RpcIdType, type ServerRequest } from './rpc.ts'

const rpcIdSchema: z.ZodType<RpcIdType, string> = z.string().min(1).transform(RpcId)

const clientRequestShape = z.object({
  type: z.literal('client-request'),
  rpcId: rpcIdSchema,
  method: z.string().min(1),
  payload: z.unknown(),
})

/**
 * Parse an inbound client request envelope.
 * @param raw - the untrusted wire value.
 * @returns the parsed envelope with a branded rpcId.
 * @throws a zod error naming every envelope violation.
 */
export function parseClientRequest(raw: unknown): ClientRequest {
  return clientRequestShape.parse(raw)
}

const serverRequestShape = z.object({
  type: z.literal('server-request'),
  rpcId: rpcIdSchema,
  method: z.string().min(1),
  payload: z.unknown(),
})

/**
 * Parse an inbound host frame on a client.
 * @param raw - the untrusted wire value.
 * @returns the parsed frame.
 * @throws a zod error naming every envelope violation.
 */
export function parseServerRequest(raw: unknown): ServerRequest {
  return serverRequestShape.parse(raw)
}
