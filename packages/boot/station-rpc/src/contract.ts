/**
 * The station domain's wire contract: operator session, settings key/value
 * persistence, business-event read/write over the audit log, and renderer
 * occupant config rows. This module is the merge point — programs importing
 * it (the bridge, renderer residents, tests) see the rows in the protocol's
 * open maps; everyone else stays untyped.
 *
 * @module @snap-rail/station-rpc/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'
import type { AuditEntry } from '@snap-rail/audit'

/** One audit record on the wire; the audit service entry is the single
 * source (no mirror type). */
export type AuditEntryInfo = AuditEntry

/** Settings key holding the signed-on operator id (`null` when signed off).
 * Shared by the host bridge (writer) and renderer mirrors (follower). */
export const SESSION_OPERATOR_KEY = 'session.operatorId'

/** Operator session: who is signed on at the station terminal. */
export interface SessionApi {
  /** The signed-on operator, or `null` when the station waits at the login page. */
  current(payload: {}): Promise<RpcResponse<{ operator: string | null }>>
  /** Sign an operator on (persisted across restarts); an empty id is a business failure. */
  login(payload: { operator: string }): Promise<RpcResponse<{ applied: true }>>
  /** Sign the current operator off. */
  logout(payload: {}): Promise<RpcResponse<{ applied: true }>>
}

/** A settings key: a lowercase domain prefix, a dot, and a non-empty name
 * (e.g. `session.operatorId`, `production.countBinding`). */
export const settingsKeySchema = z.string().min(3).max(128).regex(
  /^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9_.-]+$/, 'settings keys are "domain.name" strings')

/**
 * Simple persisted configuration: the host's `settings.json` key/value
 * document. Keys are namespaced (`domain.name`); every write persists
 * atomically and broadcasts a `settings/changed` frame so renderer occupants
 * hot-apply instead of waiting for a restart. Complex per-plugin config
 * still lives in `plugins.yml`.
 */
export interface SettingsApi {
  /** Read one key's value; `null` when the key was never set. */
  get(payload: { key: string }): Promise<RpcResponse<{ value: unknown }>>
  /** Write one key and broadcast the change (`value`'s shape is the consumer's contract). */
  set(payload: { key: string, value: unknown }): Promise<RpcResponse<{ applied: true }>>
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

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'session.current': SessionApi['current']
    'session.login': SessionApi['login']
    'session.logout': SessionApi['logout']
    'settings.get': SettingsApi['get']
    'settings.set': SettingsApi['set']
    'audit.list': AuditApi['list']
    'audit.record': AuditApi['record']
    'client-config.list': ClientConfigApi['list']
  }

  interface FrameMap {
    /** Follows every settings.json write; consumers filter by key. */
    'settings/changed': { key: string, value: unknown }
  }
}

const emptyRequest = z.object({}).strict()

/** Request schemas for the station domain's methods (ride with registration). */
export const stationRequestSchemas = {
  'session.current': emptyRequest,
  'session.login': z.object({ operator: z.string().min(1) }).strict(),
  'session.logout': emptyRequest,
  'settings.get': z.object({ key: settingsKeySchema }).strict(),
  'settings.set': z.object({ key: settingsKeySchema, value: z.unknown() }).strict(),
  'audit.list': z.object({
    actions: z.array(z.string().min(1)).optional(),
    actor: z.string().min(1).optional(),
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }).strict(),
  'audit.record': z.object({
    action: z.string().min(1),
    subject: z.string().optional(),
    detail: z.unknown().optional(),
  }).strict(),
  'client-config.list': emptyRequest,
} as const

/** Payload schema of the `settings/changed` frame. */
export const settingsChangedSchema = z.object({ key: settingsKeySchema, value: z.unknown() }).strict()
