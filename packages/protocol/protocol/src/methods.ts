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

/** Wire-level capability discovery. */
export interface RpcIntrospectApi {
  /** Every live domain claim, method route, and frame registration — the
   * surface an external tool (settings UI, agent, future plugin installer)
   * lists before calling. */
  describe(payload: {}): Promise<RpcResponse<{ domains: readonly DomainInfo[], methods: readonly MethodInfo[], frames: readonly FrameInfo[] }>>
}

/**
 * Native window controls for frameless shells. The handler targets the
 * shell's single main window; phase 1 is one-window by design.
 */
export interface WindowApi {
  /** Apply a window action (`minimize`, `toggle-maximize`, `close`); `false` when no window exists to act on. */
  control(payload: { action: 'minimize' | 'toggle-maximize' | 'close' }): Promise<RpcResponse<{ applied: boolean }>>
  /** Native zip picker for the plugin installer; `null` when cancelled. */
  pickZip(payload: { title?: string | undefined }): Promise<RpcResponse<string | null>>
  /** Relaunch the app (suite switches need a fresh boot to remount). */
  relaunch(payload: Record<string, never>): Promise<RpcResponse<{ applied: true }>>
}

/** Every unary method callable by a client, keyed by its wire method name.
 * Open for declaration merging — see the module note for where rows live. */
export interface RpcMethodMap {
  'host.describe': HostApi['describe']
  'rpc.describe': RpcIntrospectApi['describe']
  'window.control': WindowApi['control']
  'window.pick-zip': WindowApi['pickZip']
  'window.relaunch': WindowApi['relaunch']
}

/** Method names on the wire. */
export type MethodName = keyof RpcMethodMap & string

/** The request payload type of a method, derived from its signature. */
export type RequestPayload<K extends MethodName> = Parameters<RpcMethodMap[K]>[0]

/** The success value type of a method, derived from its signature. */
export type ResponseValue<K extends MethodName> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
