/**
 * The unary method table: signatures are the single source of truth. The map
 * registers the methods themselves; every other position (gateway handlers,
 * clients, schemas, tests) references the derived generics. Adding a method:
 * one interface signature + one map row + one schema pair + one route.
 *
 * Reserved-method discipline: the map holds only implemented methods; an
 * unknown method fails loud at dispatch (`bad-request`) — no
 * not-implemented fallback code.
 *
 * @module @snap-rail/protocol/methods
 */

import type { RpcResponse } from './rpc.ts'
import type { ConnectionSnapshot, PointDescriptor, PointSample, PointValue } from './field.ts'

/** Host-level introspection. */
export interface HostApi {
  /** Describe the running application: identity for handshakes and About panels. */
  describe(payload: {}): Promise<RpcResponse<{ name: string, version: string, bin: string }>>
}

/** The point table: read, subscribe, and write control values. */
export interface PointsApi {
  /** List every point currently in the point table. */
  list(payload: {}): Promise<RpcResponse<{ points: readonly PointDescriptor[] }>>
  /** Read current values; unknown ids fail; a registered point with no
   * sample yet reads as a `null`-valued sample (`time` 0). */
  read(payload: { ids: readonly string[] }): Promise<RpcResponse<{ samples: readonly PointSample[] }>>
  /** Write a control value to a point (routed to the owning driver). */
  write(payload: { id: string, value: Exclude<PointValue, null> }): Promise<RpcResponse<{ accepted: true }>>
  /** Subscribe to `point/updated` frames for these ids (accumulates). */
  subscribe(payload: { ids: readonly string[] }): Promise<RpcResponse<{ subscribed: true }>>
  /** Drop these ids from the subscription (unlisted ids stay subscribed). */
  unsubscribe(payload: { ids: readonly string[] }): Promise<RpcResponse<{ unsubscribed: true }>>
}

/** Connections: the device side of the field seam. */
export interface ConnectionsApi {
  /** List connections with live status. */
  list(payload: {}): Promise<RpcResponse<{ connections: readonly ConnectionSnapshot[] }>>
}

/**
 * Native window controls for frameless shells. The handler targets the
 * shell's single main window; phase 1 is one-window by design.
 */
export interface WindowApi {
  /** Apply a window action (`minimize`, `toggle-maximize`, `close`); `false` when no window exists to act on. */
  control(payload: { action: 'minimize' | 'toggle-maximize' | 'close' }): Promise<RpcResponse<{ applied: boolean }>>
}

/** Where a plugin row comes from in the merged view. */
export type PluginSource = 'builtin' | 'user' | 'pool'

/** One plugin as the management surface sees it. */
export interface PluginInfo {
  /** Package name; also the entry id in the composed list. */
  name: string
  /** Origin: shipped layer, user-layer insert, or available-in-pool only. */
  source: PluginSource
  /** Whether it is currently mounted (`false` covers disabled and unreferenced pool plugins). */
  enabled: boolean
  /** The entry's current config when one is set. */
  config?: unknown
}

/** Plugin administration over the two-layer composition. */
export interface PluginsApi {
  /** Merged view: mounted entries with status plus pool plugins not referenced. */
  list(payload: {}): Promise<RpcResponse<{ plugins: readonly PluginInfo[] }>>
  /** Enable or disable one plugin by writing a user-layer row and hot-applying. */
  setEnabled(payload: { name: string, enabled: boolean }): Promise<RpcResponse<{ applied: true }>>
  /** Replace one plugin's config through a user-layer row and hot-apply. */
  setConfig(payload: { name: string, config: unknown }): Promise<RpcResponse<{ applied: true }>>
}

/** Every unary method callable by a client, keyed by its wire method name. */
export interface RpcMethodMap {
  'host.describe': HostApi['describe']
  'points.list': PointsApi['list']
  'points.read': PointsApi['read']
  'points.write': PointsApi['write']
  'points.subscribe': PointsApi['subscribe']
  'points.unsubscribe': PointsApi['unsubscribe']
  'connections.list': ConnectionsApi['list']
  'window.control': WindowApi['control']
  'plugins.list': PluginsApi['list']
  'plugins.setEnabled': PluginsApi['setEnabled']
  'plugins.setConfig': PluginsApi['setConfig']
}

/** Method names on the wire. */
export type MethodName = keyof RpcMethodMap & string

/** The request payload type of a method, derived from its signature. */
export type RequestPayload<K extends MethodName> = Parameters<RpcMethodMap[K]>[0]

/** The success value type of a method, derived from its signature. */
export type ResponseValue<K extends MethodName> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
