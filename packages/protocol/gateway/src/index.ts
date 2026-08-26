/**
 * Host-side RPC dispatch: capability plugins register typed method handlers;
 * carriers deliver envelopes; the gateway validates at the trust boundary,
 * dispatches, and pumps broadcast frames to attached downlinks.
 *
 * @module @snap-rail/gateway
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Context, Service, type Plugin } from '@snap-rail/cordis'
import {
  RpcBusinessError,
  RpcId,
  err,
  ok,
  parseClientRequest,
  parseMethodPayload,
  type MethodName,
  type RequestPayload,
  type ResponseValue,
  type RpcId as RpcIdType,
  type RpcResult,
  type ServerRequest,
  type ServerResponse,
} from '@snap-rail/protocol'

declare module '@snap-rail/cordis' {
  interface Context {
    gateway: GatewayService
  }
}

/** Envelope-shaped failure raised before an rpcId exists to echo. */
export class GatewayEnvelopeError extends Error {
  constructor(cause: unknown) {
    super('gateway: malformed client request envelope', { cause })
    this.name = 'GatewayEnvelopeError'
  }
}

/** One attached frame consumer (an Electron port writer, a test pump). */
export type Downlink = (frame: ServerRequest) => void

type UntypedHandler = (payload: unknown, rpcId: RpcIdType) => Promise<unknown>

/** Host-side RPC service exposed as `ctx.gateway`. */
export interface GatewayService {
  /** Register a typed method handler; the returned disposer removes the route. */
  registerMethod<K extends MethodName>(
    method: K,
    handler: (payload: RequestPayload<K>, rpcId: RpcIdType) => Promise<ResponseValue<K>> | ResponseValue<K>,
  ): () => void
  /** Handle one full-form client request; always settles with a server response. */
  handleClientRequest(request: unknown): Promise<ServerResponse>
  /** Broadcast one push frame to every attached downlink. */
  broadcast(method: string, payload: unknown): ServerRequest
  /** Attach a frame consumer; the returned disposer detaches it. */
  attachDownlink(downlink: Downlink): () => void
}

class GatewayServiceImpl extends Service {
  private readonly routes = new Map<string, UntypedHandler>()
  private readonly downlinks = new Set<Downlink>()
  private frameCounter = 0

  constructor(ctx: Context, config: GatewayConfig) {
    super(ctx, 'gateway')
    this.registerMethod('host.describe', () => ({
      name: config.name,
      version: config.version,
      bin: config.bin,
    }))
  }

  registerMethod<K extends MethodName>(
    method: K,
    handler: (payload: RequestPayload<K>, rpcId: RpcIdType) => Promise<ResponseValue<K>> | ResponseValue<K>,
  ): () => void {
    const untyped: UntypedHandler = async (payload, rpcId) => handler(payload as RequestPayload<K>, rpcId)
    this.routes.set(method, untyped)
    return () => {
      // A same-name re-registration replaces the route; only dispose when
      // this registration is still the live one.
      if (this.routes.get(method) === untyped) this.routes.delete(method)
    }
  }

  async handleClientRequest(request: unknown): Promise<ServerResponse> {
    let parsed
    try {
      parsed = parseClientRequest(request)
    } catch (cause) {
      throw new GatewayEnvelopeError(cause)
    }
    const { rpcId, method, payload } = parsed
    const route = this.routes.get(method)
    if (route === undefined) {
      return respond(rpcId, err('bad-request', { issues: [`unknown method: ${method}`] }))
    }
    let typedPayload: unknown
    try {
      typedPayload = parseMethodPayload(method as MethodName, payload)
    } catch (cause) {
      const issues = zodIssues(cause)
      return respond(rpcId, err('bad-request', { issues }))
    }
    let result: RpcResult<unknown>
    try {
      result = ok(await route(typedPayload, rpcId))
    } catch (cause) {
      if (cause instanceof RpcBusinessError) result = { ok: false, error: cause.error }
      else {
        this.ctx.logger('gateway').error?.(cause)
        result = err('internal', { hint: 'method handler failed' })
      }
    }
    return respond(rpcId, result)
  }

  broadcast(method: string, payload: unknown): ServerRequest {
    const frame: ServerRequest = {
      type: 'server-request',
      rpcId: RpcId(`${randomUUID()}-${++this.frameCounter}`),
      method,
      payload,
    }
    for (const downlink of this.downlinks) downlink(frame)
    return frame
  }

  attachDownlink(downlink: Downlink): () => void {
    this.downlinks.add(downlink)
    return () => {
      this.downlinks.delete(downlink)
    }
  }
}

function respond(rpcId: RpcIdType, result: RpcResult<unknown>): ServerResponse {
  return { type: 'server-response', rpcId, result }
}

function zodIssues(cause: unknown): readonly string[] {
  const issues = (cause as { issues?: unknown[] } | null)?.issues
  if (!Array.isArray(issues)) return [String(cause)]
  return issues.map(issue => {
    const path = Array.isArray((issue as { path?: unknown }).path)
      ? (issue as { path: (string | number | symbol)[] }).path.join('.')
      : ''
    return path === '' ? String((issue as { message?: unknown }).message) : `${path}: ${String((issue as { message?: unknown }).message)}`
  })
}

/** Gateway plugin config: application identity served by `host.describe`. */
export interface GatewayConfig {
  name: string
  version: string
  bin: string
}

/** Gateway plugin: mounts `ctx.gateway`. */
const gatewayPlugin: Plugin.Object<GatewayConfig> = {
  name: 'gateway',
  Config: z.object({
    name: z.string(),
    version: z.string(),
    bin: z.string(),
  }) satisfies z.ZodType<GatewayConfig>,
  apply(ctx: Context, config: GatewayConfig): void {
    new GatewayServiceImpl(ctx, config)
  },
}

export default gatewayPlugin
