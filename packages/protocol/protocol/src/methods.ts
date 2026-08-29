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
import type { ModbusDeviceConfig, ModbusDevicesDocument, ModbusPointConfig, ModbusVarConfig } from './modbus.ts'

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

/** Operator session: who is signed on at the station terminal. */
export interface SessionApi {
  /** The signed-on operator, or `null` when the station waits at the login page. */
  current(payload: {}): Promise<RpcResponse<{ operator: string | null }>>
  /** Sign an operator on (persisted across restarts); an empty id is a business failure. */
  login(payload: { operator: string }): Promise<RpcResponse<{ applied: true }>>
  /** Sign the current operator off. */
  logout(payload: {}): Promise<RpcResponse<{ applied: true }>>
}

/** One audit record on the wire; mirrors the audit service entry shape. */
export interface AuditEntryInfo {
  /** Wall-clock epoch milliseconds. */
  time: number
  /** Who caused the action (`actor` of the audit entry). */
  actor: string
  /** What happened (`maintenance.complete`, `production.start`, ...). */
  action: string
  /** What the action targeted, when a single target exists. */
  subject?: string
  /** Action-specific detail. */
  detail?: unknown
}

/** Reading and appending station business events (the audit log). */
export interface AuditApi {
  /** Read persisted entries, oldest-first; `limit` keeps the newest N. */
  list(payload: {
    actions?: readonly string[] | undefined
    actor?: string | undefined
    since?: number | undefined
    limit?: number | undefined
  }): Promise<RpcResponse<{ entries: readonly AuditEntryInfo[] }>>
  /** Append one business event; the actor is the signed-on operator, resolved host-side. */
  record(payload: { action: string, subject?: string | undefined, detail?: unknown }): Promise<RpcResponse<{ time: number }>>
}

/** One renderer-occupant row carved out of the user layer. */
export interface ClientConfigRow {
  /** Renderer occupant package name (the row key). */
  name: string
  /** Whether the occupant mounts (`absent` rows default to enabled). */
  enabled: boolean
  /** The occupant's config when the row carries one. */
  config?: unknown
}

/** Renderer-occupant configuration carved out of the shared `plugins.yml`. */
export interface ClientConfigApi {
  /** Rows present in the user layer for known renderer packages. */
  list(payload: {}): Promise<RpcResponse<{ rows: readonly ClientConfigRow[] }>>
}

/**
 * ModbusTCP device administration: CRUD over the driver's device table and
 * variable mappings, plus a connection probe. Every mutation writes the
 * driver's store tables and hot-applies per device.
 */
export interface ModbusApi {
  /** The whole document the settings page renders: devices, mappings, manual vars. */
  listDevices(payload: {}): Promise<RpcResponse<ModbusDevicesDocument>>
  /** Insert or replace one device; reconnects only that device when live. */
  upsertDevice(payload: { device: ModbusDeviceConfig }): Promise<RpcResponse<{ applied: true }>>
  /** Remove one device and its mappings; drops the connection. */
  removeDevice(payload: { id: string }): Promise<RpcResponse<{ applied: true }>>
  /** Probe a device address without touching the stored table. */
  testDevice(payload: { device: ModbusDeviceConfig }): Promise<RpcResponse<{ ok: boolean, error?: string | undefined }>>
  /** Insert or replace one variable mapping (the variable must exist as a declared or manual var). */
  upsertPoint(payload: { point: ModbusPointConfig }): Promise<RpcResponse<{ applied: true }>>
  /** Remove one variable mapping by variable name. */
  removePoint(payload: { id: string }): Promise<RpcResponse<{ applied: true }>>
  /** Declare a hand debugging variable (name + semantic type). */
  upsertVar(payload: { name: string, type: ModbusVarConfig['type'] }): Promise<RpcResponse<{ applied: true }>>
  /** Remove a hand debugging variable; its mapping goes with it. */
  removeVar(payload: { name: string }): Promise<RpcResponse<{ applied: true }>>
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
  'session.current': SessionApi['current']
  'session.login': SessionApi['login']
  'session.logout': SessionApi['logout']
  'audit.list': AuditApi['list']
  'audit.record': AuditApi['record']
  'client-config.list': ClientConfigApi['list']
  'modbus.devices.list': ModbusApi['listDevices']
  'modbus.devices.upsert': ModbusApi['upsertDevice']
  'modbus.devices.remove': ModbusApi['removeDevice']
  'modbus.devices.test': ModbusApi['testDevice']
  'modbus.vars.upsert': ModbusApi['upsertVar']
  'modbus.vars.remove': ModbusApi['removeVar']
  'modbus.points.upsert': ModbusApi['upsertPoint']
  'modbus.points.remove': ModbusApi['removePoint']
}

/** Method names on the wire. */
export type MethodName = keyof RpcMethodMap & string

/** The request payload type of a method, derived from its signature. */
export type RequestPayload<K extends MethodName> = Parameters<RpcMethodMap[K]>[0]

/** The success value type of a method, derived from its signature. */
export type ResponseValue<K extends MethodName> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
