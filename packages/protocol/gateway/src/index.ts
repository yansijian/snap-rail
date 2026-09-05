/**
 * Host-side RPC dispatch and the topic layer, exposed as `ctx.rpc` and
 * `ctx.topic`: capability plugins claim a wire domain, then register method
 * handlers whose request schemas travel with the registration; carriers
 * deliver envelopes; the service validates at the trust boundary, dispatches,
 * and pumps frames to attached downlinks. Topics are the push primitive with
 * subscription semantics: a plugin declares a topic (payload schema, optional
 * filter schema, gate predicate), anyone publishes, and a publication only
 * reaches the wire while some subscriber's gate matches it.
 *
 * Ownership: `method`/`frame`/`claimDomain`/`declare` registrations ride the
 * caller's effect scope — unloading the owning plugin drops its methods,
 * frames, topics, and domain claims (the same ownership rule cordis services
 * follow). Domain claims are first-wins and fail loud: a namespace collision
 * between plugins is a boot-time error, never a silent override. A same-name
 * method re-registration replaces the route (hot-reload semantics);
 * cross-plugin collisions are what claims prevent. Topic names are owned by
 * their declarer outright (independent of the method-domain claims, so a
 * plugin can publish from its core while its rpc bridge claims the domain).
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
  type TopicDescriptor,
} from '@snap-rail/protocol'

declare module '@snap-rail/cordis' {
  interface Context {
    rpc: GatewayService
    topic: TopicService
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

/** One declared topic: payload/filter schemas, gate predicate, owning fiber. */
interface TopicRegistration {
  payload: z.ZodType
  filter?: z.ZodType
  match?: (filter: never, payload: never) => boolean
  owner: Fiber
}

/** A declaration as the implementation stores it (schemas loose; the typed
 * surface is the generic overload on {@link TopicService.declare}). */
interface TopicDeclareDecl {
  payload: z.ZodType
  filter?: z.ZodType
  match?: (filter: never, payload: never) => boolean
}

/** One host-side subscriber (a plugin consuming another domain's stream). */
interface HostSubscription {
  topic: string
  filter: unknown
  listener: (payload: never) => void
}

/** One wire-side subscription gate opened by a renderer via `topic.subscribe`. */
interface WireSubscription {
  topic: string
  filter: unknown
}

/** Declaration payload for {@link TopicService.declare}. */
export interface TopicDeclareDef<S extends z.ZodType = z.ZodType, F extends z.ZodType = z.ZodType> {
  /** The payload schema — publish validates against it (the topic's trust boundary). */
  payload: S
  /** The subscription-filter schema; both subscribe paths validate against it. */
  filter?: F
  /** The gate predicate: does this filter want this payload? Without a
   * `match`, every payload of the topic matches every subscriber. */
  match?: (filter: z.output<F>, payload: z.output<S>) => boolean
}

/** Host-side topic service exposed as `ctx.topic`. */
export interface TopicService {
  /**
   * Declare a topic: its wire name (`domain/event`), payload schema, optional
   * subscription-filter schema, and gate predicate. First-wins per name and
   * fail loud across plugins: a same-name declaration by a different fiber
   * fails; the same fiber replaces (hot-reload semantics). Topic ownership is
   * independent of the method-domain claims — the declaring plugin owns the
   * name outright. The declaration rides the caller's effect scope; a live
   * wire gate on the topic dies with it.
   *
   * @param caller - owning context; unload drops the declaration.
   * @param name - the wire topic name (`domain/event`).
   * @param def - payload schema (mandatory), optional filter schema and gate.
   * @returns a disposer that drops the declaration.
   */
  declare<S extends z.ZodType = z.ZodType, F extends z.ZodType = z.ZodType>(
    caller: Context,
    name: string,
    def: TopicDeclareDef<S, F>,
  ): () => void
  /**
   * Publish one payload. Validated against the declaration (fail loud on
   * mismatch — a host-side contract breach, not a wire error), then delivered
   * to matching host-side subscribers directly, and broadcast on the wire
   * only while at least one wire-side gate's filter matches: an unsubscribed
   * topic costs no wire traffic at all.
   *
   * @param name - the declared topic name.
   * @param payload - the publication; zod-parsed before anyone sees it.
   */
  publish(name: string, payload: unknown): void
  /**
   * Host-side subscription: the listener receives every published payload
   * the gate predicate accepts — host delivery skips the wire entirely.
   * The filter is validated against the declaration's filter schema. Rides
   * the caller's effect scope.
   *
   * @param caller - subscribing context; unload drops the subscription.
   * @param name - the declared topic name.
   * @param filter - the subscription filter (declaration-schema-validated).
   * @param listener - receives each matching parsed payload.
   * @returns the unsubscribe function.
   */
  subscribe<P = unknown>(caller: Context, name: string, filter: unknown, listener: (payload: P) => void): () => void
  /** The live declarations — what `topic.list` serves on the wire. */
  list(): TopicDescriptor[]
}

/** Host-side RPC service exposed as `ctx.rpc`. */
export interface GatewayService {
  /**
   * Claim a wire-domain prefix — one or two dot segments for methods
   * (`field`, `field.modbus`); frame and topic names use the single-segment
   * form of the same vocabulary (`field/point-update` → `field`). First claim
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
  /**
   * The live registry view (domains, methods with JSON schemas, frames,
   * topics) — the same object `rpc.describe` serves on the wire. Host-side
   * consumers (capability catalogs, agent tooling) read it directly instead
   * of round-tripping a client request through their own dispatcher.
   */
  describe(): { domains: DomainInfo[], methods: MethodInfo[], frames: FrameInfo[], topics: TopicDescriptor[] }
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
  private readonly topics = new Map<string, TopicRegistration>()
  private readonly hostSubs = new Set<HostSubscription>()
  private readonly wireSubs = new Map<string, WireSubscription>()
  private frameCounter = 0
  private subscriptionCounter = 0
  /** The topic half of this service, provided alongside `rpc` as `ctx.topic`. */
  readonly topic: TopicService

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
    this.installRoute('topic.subscribe', {
      request: z.object({ topic: z.string().min(1), filter: z.unknown().optional() }).strict(),
      handler: ({ topic, filter }) => this.subscribeWire(topic, filter),
    })
    this.installRoute('topic.unsubscribe', {
      request: z.object({ subscriptionId: z.string().min(1) }).strict(),
      handler: ({ subscriptionId }) => this.unsubscribeWire(subscriptionId),
    })
    this.installRoute('topic.list', {
      request: z.object({}).strict(),
      handler: () => ({ topics: this.listTopics() }),
    })
    this.topic = {
      declare: (caller, name, def) => this.declareTopic(caller, name, def),
      publish: (name, payload) => this.publishTopic(name, payload),
      subscribe: (caller, name, filter, listener) =>
        this.subscribeHost(caller, name, filter, listener as (payload: never) => void),
      list: () => this.listTopics(),
    }
  }

  /** The live registry view behind `rpc.describe`. */
  describe(): { domains: DomainInfo[], methods: MethodInfo[], frames: FrameInfo[], topics: TopicDescriptor[] } {
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
    return { domains, methods, frames, topics: this.listTopics() }
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

  // ---- topics ----

  private declareTopic(caller: Context, name: string, def: TopicDeclareDecl): () => void {
    if (!frameNamePattern.test(name)) {
      throw new Error(`topic: invalid topic name "${name}" (domain/event, kebab segments joined by "/")`)
    }
    if (def.payload === undefined) {
      throw new Error(`topic: "${name}" requires a payload schema`)
    }
    const existing = this.topics.get(name)
    if (existing !== undefined && existing.owner !== caller.fiber) {
      throw new Error(`topic: "${name}" is already declared by <${existing.owner.name}>`)
    }
    const registration: TopicRegistration = {
      payload: def.payload,
      ...(def.filter !== undefined ? { filter: def.filter } : {}),
      ...(def.match !== undefined ? { match: def.match as (filter: never, payload: never) => boolean } : {}),
      owner: caller.fiber,
    }
    this.topics.set(name, registration)
    const remove = (): void => {
      if (this.topics.get(name) !== registration) return
      this.topics.delete(name)
      // Gates on a dead topic are dead references: drop them with it.
      for (const [id, sub] of [...this.wireSubs]) {
        if (sub.topic === name) this.wireSubs.delete(id)
      }
    }
    caller.effect(() => remove)
    return remove
  }

  private publishTopic(name: string, payload: unknown): void {
    const topic = this.topics.get(name)
    if (topic === undefined) {
      throw new Error(`topic: "${name}" is not declared — declare it with ctx.topic.declare first`)
    }
    let value: unknown
    try {
      value = topic.payload.parse(payload)
    } catch (cause) {
      throw new Error(`topic: payload for "${name}" failed its schema`, { cause })
    }
    for (const sub of this.hostSubs) {
      if (sub.topic !== name || !this.gateAccepts(topic, sub.filter, value)) continue
      sub.listener(value as never)
    }
    // The wire gate: a publication climbs to the wire only when some
    // renderer's filter wants it — unsubscribed topics cost nothing.
    let wireWants = false
    for (const sub of this.wireSubs.values()) {
      if (sub.topic === name && this.gateAccepts(topic, sub.filter, value)) {
        wireWants = true
        break
      }
    }
    if (wireWants) this.broadcast(name, value)
  }

  private subscribeHost(caller: Context, name: string, filter: unknown, listener: (payload: never) => void): () => void {
    const topic = this.topics.get(name)
    if (topic === undefined) {
      throw new Error(`topic: "${name}" is not declared — declare it with ctx.topic.declare first`)
    }
    const parsed = this.parseFilter(topic, name, filter, issues => {
      throw new Error(`topic: filter for "${name}" rejected: ${issues.join('; ')}`)
    })
    const sub: HostSubscription = { topic: name, filter: parsed, listener }
    this.hostSubs.add(sub)
    const remove = (): void => {
      this.hostSubs.delete(sub)
    }
    caller.effect(() => remove)
    return remove
  }

  /** Wire-side subscribe (`topic.subscribe`): open a gate, return its id. */
  private subscribeWire(name: string, filter: unknown): { subscriptionId: string } {
    const topic = this.topics.get(name)
    if (topic === undefined) {
      throw new RpcBusinessError({ code: 'not-found', details: { what: `unknown topic: ${name}` } })
    }
    const parsed = this.parseFilter(topic, name, filter, issues => {
      throw new RpcBusinessError({ code: 'bad-request', details: { issues } })
    })
    const id = `${randomUUID()}-${++this.subscriptionCounter}`
    this.wireSubs.set(id, { topic: name, filter: parsed })
    return { subscriptionId: id }
  }

  /** Wire-side unsubscribe (`topic.unsubscribe`). */
  private unsubscribeWire(id: string): { unsubscribed: true } {
    if (!this.wireSubs.delete(id)) {
      throw new RpcBusinessError({ code: 'not-found', details: { what: `unknown subscription: ${id}` } })
    }
    return { unsubscribed: true } as const
  }

  private listTopics(): TopicDescriptor[] {
    const topics: TopicDescriptor[] = []
    for (const [name, topic] of this.topics) {
      const info: TopicDescriptor = { name }
      const payload = jsonSchemaOf(topic.payload)
      if (payload !== undefined) info.payloadSchema = payload
      if (topic.filter !== undefined) {
        const filter = jsonSchemaOf(topic.filter)
        if (filter !== undefined) info.filterSchema = filter
      }
      topics.push(info)
    }
    return topics
  }

  /** The declaration's gate predicate; no `match` means everyone matches. */
  private gateAccepts(topic: TopicRegistration, filter: unknown, payload: unknown): boolean {
    return topic.match === undefined || topic.match(filter as never, payload as never)
  }

  /** Validate a subscription filter against the declaration: a topic without
   * a filter schema takes no filter; one with it zod-parses (missing → `{}`). */
  private parseFilter(topic: TopicRegistration, name: string, filter: unknown, onFail: (issues: readonly string[]) => never): unknown {
    if (topic.filter === undefined) {
      if (filter === undefined) return {}
      throw onFail([`topic "${name}" declares no filter`])
    }
    const parsed = topic.filter.safeParse(filter ?? {})
    if (!parsed.success) throw onFail(zodIssues(parsed.error))
    return parsed.data
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
    const impl = new GatewayServiceImpl(ctx, config)
    ctx.provide('topic', impl.topic)
  },
}

export default gatewayPlugin
