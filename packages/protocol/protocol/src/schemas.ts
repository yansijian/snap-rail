/**
 * zod validation at the trust boundary: the envelope once (type/rpcId/method
 * structure), then the business payload dispatched by method for a second
 * parse. Rejection is `bad-request`. Host responses are produced by trusted
 * code and are not re-validated in phase 1.
 *
 * @module @snap-rail/protocol/schemas
 */

import { z } from 'zod'
import { RpcId, type ClientRequest, type RpcId as RpcIdType, type ServerRequest } from './rpc.ts'
import type { MethodName, RequestPayload } from './methods.ts'

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
 * @throws a zod error naming every violation.
 */
export function parseServerRequest(raw: unknown): ServerRequest {
  return serverRequestShape.parse(raw)
}

/** Request schemas per method; the single home of payload validation. */
export const methodRequestSchemas: { readonly [K in MethodName]: z.ZodType<RequestPayload<K>> } = {
  'host.describe': z.object({}).strict(),
  'points.list': z.object({}).strict(),
  'points.read': z.object({ ids: z.array(z.string().min(1)).min(1) }).strict(),
  'points.write': z.object({
    id: z.string().min(1),
    value: z.union([z.boolean(), z.number(), z.bigint(), z.string()]),
  }).strict(),
  'points.subscribe': z.object({ ids: z.array(z.string().min(1)).min(1) }).strict(),
  'points.unsubscribe': z.object({ ids: z.array(z.string().min(1)).min(1) }).strict(),
  'connections.list': z.object({}).strict(),
}

/**
 * Validate a business payload against its method's schema.
 * @param method - the wire method name.
 * @param payload - the untrusted payload.
 * @throws a zod error the caller reports as `bad-request` issues.
 */
export function parseMethodPayload(method: MethodName, payload: unknown): unknown {
  return methodRequestSchemas[method].parse(payload)
}
