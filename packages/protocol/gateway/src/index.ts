/**
 * Host-side RPC dispatch, exposed as `ctx.rpc`: capability plugins claim a
 * wire domain, then register method handlers whose request schemas travel
 * with the registration; carriers deliver envelopes; the service validates
 * at the trust boundary, dispatches, and pumps broadcast frames to attached
 * downlinks.
 *
 * Ownership: `method`/`frame`/`claimDomain` registrations ride the caller's
 * effect scope — unloading the owning plugin drops its methods, frames, and
 * domain claims (the same ownership rule cordis services follow). Domain
 * claims are first-wins and fail loud: a namespace collision between
 * plugins is a boot-time error, never a silent override. A same-name method
 * re-registration replaces the route (hot-reload semantics); cross-plugin
 * collisions are what claims prevent.
 *
 * @module @snap-rail/gateway
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Context, Service, type Events, type Fiber, type Plugin } from '@snap-rail/cordis'
import {
  RpcBusinessError,
  RpcId,
  err,
  ok,
  parseClientRequest,
  type DomainInfo,
  type FrameInfo,
  type FrameName,
  type FramePayload,
  type MethodInfo,
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
    rpc: GatewayService
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

/** A method handler as stored after registration (payload already parsed). */
type UntypedHandler = (payload: never, rpcId: RpcIdType) => unknown

/** One installed method route: the handler plus its trust-boundary schemas. */
interface Route {
  request: z.ZodType
  response?: z.ZodType
  handler: UntypedHandler
}

/** One registered push frame: the payload schema plus its owning fiber. */
interface FrameRegistration {
  payload: z.ZodType
  owner: Fiber
}

/** Host-side RPC service exposed as `ctx.rpc`. */
export interface GatewayService {
  /**
   * Claim a wire-domain prefix — one or two dot segments for methods
   * (`field`, `field.modbus`); frame names use the single-segment form of
   * the same vocabulary (`field/point-updated` → `field`). First claim
   * wins; a second claim of a live prefix fails loud. The claim rides the
   * caller's effect scope.
   *
   * @param caller - owning context; unload releases the claim.
   * @param prefix - the domain prefix to claim.
   * @returns a disposer that releases the claim.
   */
  claimDomain(caller: Context, prefix: string): () => void
  /**
   * Open method registration: the request schema is mandatory and is the
   * trust-boundary validation; the optional response schema self-checks
   * host output at dispatch. The method's domain must be claimed by the
   * same caller. The route rides the caller's effect scope and replaces a
   * same-name route (hot-reload semantics).
   *
   * Typed overload for methods known to the (merged) `RpcMethodMap`; the
   * schema-generic overload types the handler from `def.request` for any
   * other name.
   */
  method<K extends MethodName>(
    caller: Context,
    name: K,
    def: { request: z.ZodType<RequestPayload<K>>, response?: z.ZodType<ResponseValue<K>> },
    handler: (payload: RequestPayload<K>, rpcId: RpcIdType) => ResponseValue<K> | Promise<ResponseValue<K>>,
  ): () => void
  method<S extends z.ZodType>(
    caller: Context,
    name: string,
    def: { request: S, response?: z.ZodType },
    handler: (payload: z.output<S>, rpcId: RpcIdType) => unknown,
  ): () => void
  /**
   * Register a push frame's payload schema. The frame's domain (the first
   * `/` segment) must be a claimed domain — by anyone: a domain's frames
   * are its collaboration surface, shared by the seam and its providers
   * (e.g. `field/modbus-config-changed` rides the field domain its driver
   * lives under). A same-name re-registration by a different fiber fails
   * loud; by the same fiber it replaces (hot-reload semantics). The schema
   * serves discovery (`rpc.describe`) and client-side parsing; `broadcast`
   * does not re-validate payloads on the hot path (host output is trusted).
   *
   * @param caller - owning context; unload drops the registration.
   * @param name - the wire frame name (`domain/event`).
   * @param def - the payload schema (mandatory).
   */
  frame<S extends z.ZodType>(caller: Context, name: string, def: { payload: S }): () => void
  /**
   * Pump one host-side cordis event out as a broadcast frame: the standard
   * host-event → wire-frame bridge (so providers never hand-write the
   * forwarding). The optional `map` shapes the event's arguments into the
   * frame payload; without it the first argument rides as-is.
   *
   * @param caller - the bridging plugin's context; the subscription rides it.
   * @param event - the host-side event name (typed against cordis `Events`).
   * @param frame - the wire frame name to broadcast.
   * @param map - payload shaper over the event's arguments.
   */
  bridgeEvent<K extends keyof Events>(
    caller: Context,
    event: K,
    frame: string,
    map?: (...args: Parameters<Events[K]>) => unknown,
  ): void
  /** Handle one full-form client request; always settles with a server response. */
  handleClientRequest(request: unknown): Promise<ServerResponse>
  /**
   * Broadcast one push frame to every attached downlink. Typed for frames
   * known to the (merged) `FrameMap`; the string overload accepts any
   * registered frame name. Payloads are host-trusted and not re-validated.
   */
  broadcast<K extends FrameName>(method: K, payload: FramePayload<K>): ServerRequest
  broadcast(method: string, payload: unknown): ServerRequest
  /** Attach a frame consumer; the returned disposer detaches it. */
  attachDownlink(downlink: Downlink): () => void
}

/** A method name: two to four lowercase kebab segments joined by dots. */
const methodNamePattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/

/** A frame name: `domain/event`, two or more kebab segments joined by `/`. */
const frameNamePattern = /^[a-z][a-z0-9-]+(\/[a-z][a-z0-9-]+)+$/

/** A domain prefix: one or two dot segments (the frame form is one segment). */
const domainPrefixPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/

class GatewayServiceImpl extends Service {
  private readonly routes = new Map<string, Route>()
  private readonly frames = new Map<string, FrameRegistration>()
  private readonly claims = new Map<string, Fiber>()
  private readonly downlinks = new Set<Downlink>()
  private frameCounter = 0

  constructor(ctx: Context, config: GatewayConfig) {
    super(ctx, 'rpc')
    // The platform rows install directly: the gateway owns the `host` and
    // `rpc` domains and needs no caller scope (it lives as long as the tree).
    this.installRoute('host.describe', {
      request: z.object({}).strict(),
      handler: () => ({
        name: config.name,
        version: config.version,
        bin: config.bin,
      }),
    })
    this.installRoute('rpc.describe', {
      request: z.object({}).strict(),
      handler: () => this.describe(),
    })
  }

  /** The live registry view behind `rpc.describe`. */
  private describe(): { domains: DomainInfo[], methods: MethodInfo[], frames: FrameInfo[] } {
    const domains = [...this.claims].map(([prefix, owner]) => ({ prefix, owner: owner.name }))
    const methods: MethodInfo[] = [...this.routes].map(([name, route]) => {
      const info: MethodInfo = { name }
      const request = jsonSchemaOf(route.request)
      if (request !== undefined) info.requestSchema = request
      if (route.response !== undefined) {
        const response = jsonSchemaOf(route.response)
        if (response !== undefined) info.responseSchema = response
      }
      return info
    })
    const frames: FrameInfo[] = [...this.frames].map(([name, registration]) => {
      const info: FrameInfo = { name }
      const payload = jsonSchemaOf(registration.payload)
      if (payload !== undefined) info.payloadSchema = payload
      return info
    })
    return { domains, methods, frames }
  }

  claimDomain(caller: Context, prefix: string): () => void {
    if (!domainPrefixPattern.test(prefix)) {
      throw new Error(`rpc: invalid domain prefix "${prefix}" (one or two lowercase kebab segments)`)
    }
    const existing = this.claims.get(prefix)
    if (existing !== undefined) {
      throw new Error(`rpc: domain "${prefix}" is already claimed by <${existing.name}>`)
    }
    const owner = caller.fiber
    this.claims.set(prefix, owner)
    const remove = (): void => {
      if (this.claims.get(prefix) === owner) this.claims.delete(prefix)
    }
    // Effects take a body producing the disposer; passing `remove` itself
    // would run it as setup.
    caller.effect(() => remove)
    return remove
  }

  method(caller: Context, name: string, def: { request?: z.ZodType, response?: z.ZodType }, handler: UntypedHandler): () => void {
    if (!methodNamePattern.test(name)) {
      throw new Error(`rpc: invalid method name "${name}" (two to four lowercase kebab segments, dot-joined)`)
    }
    if (def.request === undefined) {
      throw new Error(`rpc: method "${name}" requires a request schema (the trust-boundary validation)`)
    }
    this.assertDomainClaimed(caller, name)
    const route: Route = {
      request: def.request,
      ...(def.response !== undefined ? { response: def.response } : {}),
      handler,
    }
    this.installRoute(name, route)
    const remove = (): void => {
      if (this.routes.get(name) === route) this.routes.delete(name)
    }
    caller.effect(() => remove)
    return remove
  }

  frame(caller: Context, name: string, def: { payload?: z.ZodType }): () => void {
    if (!frameNamePattern.test(name)) {
      throw new Error(`rpc: invalid frame name "${name}" (domain/event, kebab segments joined by "/")`)
    }
    if (def.payload === undefined) {
      throw new Error(`rpc: frame "${name}" requires a payload schema`)
    }
    const domain = name.split('/')[0] ?? name
    if (!this.claims.has(domain)) {
      throw new Error(`rpc: frame "${name}" belongs to an unclaimed domain "${domain}" — claim it with ctx.rpc.claimDomain first`)
    }
    const existing = this.frames.get(name)
    if (existing !== undefined && existing.owner !== caller.fiber) {
      throw new Error(`rpc: frame "${name}" is already registered by <${existing.owner.name}>`)
    }
    const registration: FrameRegistration = { payload: def.payload, owner: caller.fiber }
    this.frames.set(name, registration)
    const remove = (): void => {
      if (this.frames.get(name) === registration) this.frames.delete(name)
    }
    caller.effect(() => remove)
    return remove
  }

  bridgeEvent(caller: Context, event: string, frame: string, map?: (...args: never[]) => unknown): void {
    // The runtime event bus is string-keyed; the typed surface is the
    // interface's generic overload over cordis `Events`.
    const on = caller.on as (name: string, listener: (...args: never[]) => void) => void
    on(event, (...args) => {
      this.broadcast(frame, map !== undefined ? map(...args) : args[0])
    })
  }

  /** Fail loud unless the method's longest claimed domain prefix (one or
   * two segments) belongs to the caller's fiber. */
  private assertDomainClaimed(caller: Context, name: string): void {
    const segments = name.split('.')
    const two = segments.length >= 3 ? `${segments[0]}.${segments[1]}` : undefined
    const prefix = two !== undefined && this.claims.has(two) ? two : segments[0] ?? name
    const owner = this.claims.get(prefix)
    if (owner === undefined) {
      throw new Error(`rpc: method "${name}" belongs to an unclaimed domain "${prefix}" — claim it with ctx.rpc.claimDomain first`)
    }
    if (owner !== caller.fiber) {
      throw new Error(`rpc: domain "${prefix}" is claimed by <${owner.name}>, not by this caller`)
    }
  }

  private installRoute(name: string, route: Route): void {
    // A same-name re-registration replaces the route; only dispose when
    // this registration is still the live one (hot-reload semantics).
    this.routes.set(name, route)
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
      typedPayload = route.request.parse(payload)
    } catch (cause) {
      const issues = zodIssues(cause)
      return respond(rpcId, err('bad-request', { issues }))
    }
    let value: unknown
    try {
      value = await route.handler(typedPayload as never, rpcId)
    } catch (cause) {
      if (cause instanceof RpcBusinessError) {
        return respond(rpcId, { ok: false, error: cause.error })
      }
      this.ctx.logger('rpc').error?.(cause)
      return respond(rpcId, err('internal', { hint: 'method handler failed' }))
    }
    if (route.response !== undefined) {
      try {
        value = route.response.parse(value)
      } catch (cause) {
        this.ctx.logger('rpc').error?.(cause)
        return respond(rpcId, err('internal', { hint: 'response failed its schema' }))
      }
    }
    return respond(rpcId, ok(value))
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

/** Best-effort JSON Schema for discovery; schemas without a JSON shape
 * (bigint payloads, etc.) simply omit their entry. */
function jsonSchemaOf(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema)
  } catch {
    return undefined
  }
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

/** Gateway plugin: mounts `ctx.rpc`. */
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
