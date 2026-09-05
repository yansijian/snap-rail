/**
 * The platform domain's method rows plus the open bases themselves: the
 * wire's platform surface is `host.*` and `window.*` (transport-adjacent,
 * owned by the gateway and the shell). Every other domain's rows live with
 * their owners and merge in from their contract modules:
 * field → `@snap-rail/field` (`./wire`), ModbusTCP →
 * `@snap-rail/driver-modbus/contract`, station → `@snap-rail/station-rpc/contract`,
 * plugin admin → `@snap-rail/app-boot/contract`. A program sees the rows of
 * every contract it imports — the open-world rule.
 *
 * Reserved-method discipline: the map holds only implemented methods; an
 * unknown method fails loud at dispatch (`bad-request`) — no
 * not-implemented fallback code.
 *
 * @module @snap-rail/protocol/methods
 */

import type { RpcResponse } from './rpc.ts'

/** Host-level introspection. */
export interface HostApi {
  /** Describe the running application: identity for handshakes and About panels. */
  describe(payload: {}): Promise<RpcResponse<{ name: string, version: string, bin: string }>>
}

/** One wire domain as `rpc.describe` serves it. */
export interface DomainInfo {
  /** The claimed prefix (`field`, `field.modbus`). */
  prefix: string
  /** The claiming plugin's fiber name. */
  owner: string
}

/** One registered method as `rpc.describe` serves it. */
export interface MethodInfo {
  name: string
  /** The request schema as JSON Schema (omitted when not representable). */
  requestSchema?: unknown
  /** The optional response schema as JSON Schema. */
  responseSchema?: unknown
}

/** One registered frame as `rpc.describe` serves it. */
export interface FrameInfo {
  name: string
  /** The payload schema as JSON Schema (omitted when not representable). */
  payloadSchema?: unknown
}

/** One declared topic as `topic.list` and `rpc.describe` serve it. */
export interface TopicDescriptor {
  /** The topic's wire name (`domain/event`). */
  name: string
  /** The payload schema as JSON Schema (omitted when not representable). */
  payloadSchema?: unknown
  /** The subscription-filter schema as JSON Schema (omitted when the topic
   * takes no filter or the schema is not representable). */
  filterSchema?: unknown
}

/** The topic layer's client face: gated push subscriptions and discovery.
 * The push primitive of the wire — a topic is a frame with subscription
 * semantics (host-side filter gates decide which publications reach it). */
export interface TopicApi {
  /** Open one wire-side subscription gate; publications flow while the
   * gate's filter matches (evaluated host-side by the declaration's match).
   * @returns the gate id `topic.unsubscribe` takes back. */
  subscribe(payload: { topic: string, filter?: unknown }): Promise<RpcResponse<{ subscriptionId: string }>>
  /** Close a subscription gate by id. */
  unsubscribe(payload: { subscriptionId: string }): Promise<RpcResponse<{ unsubscribed: true }>>
  /** Every live topic declaration — the discovery surface for binding UIs
   * and capability catalogs. */
  list(payload: {}): Promise<RpcResponse<{ topics: readonly TopicDescriptor[] }>>
}

/** Wire-level capability discovery. */
export interface RpcIntrospectApi {
  /** Every live domain claim, method route, frame registration, and topic
   * declaration — the surface an external tool (settings UI, agent, future
   * plugin installer) lists before calling. */
  describe(payload: {}): Promise<RpcResponse<{ domains: readonly DomainInfo[], methods: readonly MethodInfo[], frames: readonly FrameInfo[], topics: readonly TopicDescriptor[] }>>
}

/**
 * Native window controls for frameless shells. Controls default to the main
 * window; `target: 'forge'` routes to the singleton AI 创造 studio window
 * (the one `openForge` opens) so its own titlebar drives its own window.
 */
export interface WindowApi {
  /** Apply a window action (`minimize`, `toggle-maximize`, `close`); `false` when no window exists to act on. */
  control(payload: { action: 'minimize' | 'toggle-maximize' | 'close', target?: 'forge' | undefined }): Promise<RpcResponse<{ applied: boolean }>>
  /** Native zip picker for the plugin installer; `null` when cancelled. */
  pickZip(payload: { title?: string | undefined }): Promise<RpcResponse<string | null>>
  /** Native zip saver (generated-plugin export); `null` when cancelled. */
  saveZip(payload: { title?: string | undefined, defaultFileName: string }): Promise<RpcResponse<string | null>>
  /** Open (or focus) the AI 创造 studio window — the app's second window, a singleton. */
  openForge(payload: Record<string, never>): Promise<RpcResponse<{ applied: true }>>
  /** Relaunch the app (suite switches need a fresh boot to remount). */
  relaunch(payload: Record<string, never>): Promise<RpcResponse<{ applied: true }>>
}

/** Every unary method callable by a client, keyed by its wire method name.
 * Open for declaration merging — see the module note for where rows live. */
export interface RpcMethodMap {
  'host.describe': HostApi['describe']
  'rpc.describe': RpcIntrospectApi['describe']
  'topic.subscribe': TopicApi['subscribe']
  'topic.unsubscribe': TopicApi['unsubscribe']
  'topic.list': TopicApi['list']
  'window.control': WindowApi['control']
  'window.pick-zip': WindowApi['pickZip']
  'window.save-zip': WindowApi['saveZip']
  'window.open-forge': WindowApi['openForge']
  'window.relaunch': WindowApi['relaunch']
}

/** Method names on the wire. */
export type MethodName = keyof RpcMethodMap & string

/** The request payload type of a method, derived from its signature. */
export type RequestPayload<K extends MethodName> = Parameters<RpcMethodMap[K]>[0]

/** The success value type of a method, derived from its signature. */
export type ResponseValue<K extends MethodName> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
