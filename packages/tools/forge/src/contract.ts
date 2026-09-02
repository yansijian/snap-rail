/**
 * The forge domain's wire contract: creation sessions with the agent loop,
 * generated-plugin administration, and the host→renderer push of generated
 * renderer halves. This module is the merge point — programs importing it
 * (the host bridge, the workbench pages, tests) see the rows in the
 * protocol's open maps; everyone else stays untyped. Pure face: zod + types
 * only, no node imports, so the client bundle may inline it.
 *
 * @module @snap-rail/forge/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'

/** Settings key holding the LLM endpoint config (`settings.get/set`, hot-applied). */
export const FORGE_LLM_KEY = 'forge.llm'

/**
 * The OpenAI-compatible endpoint config: any vendor whose `/chat/completions`
 * speaks the OpenAI wire shape works (DeepSeek, GLM, OpenAI, a local gateway).
 * `baseUrl` carries the version segment (e.g. `https://api.deepseek.com/v1`).
 */
export const llmConfigSchema = z.object({
  baseUrl: z.string().min(1).max(512),
  apiKey: z.string().min(1).max(512),
  model: z.string().min(1).max(256),
}).strict()

/** The validated LLM endpoint config. */
export type LlmConfig = z.output<typeof llmConfigSchema>

/** One creation session's summary row. */
export interface SessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** One persisted conversation turn (`meta` carries tool-call records). */
export interface SessionMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  meta?: unknown
}

/** Live status of one generated plugin's host half (diagnostics carry detail). */
export type GeneratedPluginStatus = 'running' | 'stopped' | 'error'

/** One generated plugin's admin view (versions and diagnostics included). */
export interface GeneratedPluginInfo {
  id: string
  title: string
  description: string
  enabled: boolean
  status: GeneratedPluginStatus
  /** The mounted version (host half); absent before the first run. */
  currentVersionId: string | null
  versionCount: number
  /** Newest runtime diagnostic (host mount or renderer load), if any. */
  diagnostics: string | null
  /** Whether a renderer half exists (some plugins are host-only). */
  hasClient: boolean
}

/** One generated plugin's renderer half as the renderer runner mounts it. */
export interface GenFace {
  /** The plugin id (stable across versions). */
  id: string
  /** The version this source belongs to (immutable once defined). */
  versionId: string
  /** Plain-JS function body: `function (require) { … return plugin }`. */
  src: string
}

/** Creation sessions: conversation with the agent loop. */
export interface ForgeSessionApi {
  list(payload: {}): Promise<RpcResponse<{ sessions: readonly SessionSummary[] }>>
  messages(payload: { sessionId: string }): Promise<RpcResponse<{ messages: readonly SessionMessage[] }>>
  /** Send one user turn; the agent run is asynchronous (progress rides frames).
   * A missing `sessionId` creates the session. `focusPluginId` injects that
   * plugin's identity, current version, and diagnostics into the turn. */
  send(payload: { sessionId?: string | undefined, text: string, focusPluginId?: string | undefined }): Promise<RpcResponse<{ sessionId: string, started: true }>>
  /** Abort the session's in-flight agent run (the turn stays unfinished). */
  stop(payload: { sessionId: string }): Promise<RpcResponse<{ stopped: boolean }>>
}

/** Generated-plugin administration (the workbench's plugin cards). */
export interface ForgePluginApi {
  list(payload: {}): Promise<RpcResponse<{ plugins: readonly GeneratedPluginInfo[] }>>
  /** One plugin's version history and sources (the source-view dialog). */
  read(payload: { id: string, versionId?: string | undefined }): Promise<RpcResponse<{
    info: GeneratedPluginInfo
    versions: ReadonlyArray<{ versionId: string, summary: string, createdAt: number, hasHost: boolean, hasClient: boolean }>
    version: { versionId: string, summary: string, hostSrc: string | null, clientSrc: string | null }
  }>>
  /** Enable/disable a plugin — mounts or unmounts both halves immediately. */
  setEnabled(payload: { id: string, enabled: boolean }): Promise<RpcResponse<{ applied: true }>>
  /** Activate a specific version (rollback = an older versionId). */
  setVersion(payload: { id: string, versionId: string }): Promise<RpcResponse<{ applied: true }>>
  /** Permanently remove a plugin and its version history. */
  remove(payload: { id: string }): Promise<RpcResponse<{ removed: true }>>
}

/** The renderer runner's callback channel (load/render diagnostics, host-fed). */
export interface ForgeReportApi {
  clientReport(payload: { id: string, versionId: string, stage: 'load' | 'render', ok: boolean, message?: string | undefined }): Promise<RpcResponse<{ received: true }>>
}

/** The renderer's boot-time pull of every enabled plugin's renderer half. */
export interface ForgeFaceApi {
  listFaces(payload: {}): Promise<RpcResponse<{ faces: readonly GenFace[] }>>
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'forge.session.list': ForgeSessionApi['list']
    'forge.session.messages': ForgeSessionApi['messages']
    'forge.session.send': ForgeSessionApi['send']
    'forge.session.stop': ForgeSessionApi['stop']
    'forge.plugin.list': ForgePluginApi['list']
    'forge.plugin.read': ForgePluginApi['read']
    'forge.plugin.set-enabled': ForgePluginApi['setEnabled']
    'forge.plugin.set-version': ForgePluginApi['setVersion']
    'forge.plugin.remove': ForgePluginApi['remove']
    'forge.client-report': ForgeReportApi['clientReport']
    'forge.gen-faces': ForgeFaceApi['listFaces']
  }

  interface FrameMap {
    /** Streaming session updates: assistant text, tool cards, run state. */
    'forge/session-delta': SessionDelta
    /** The generated-plugin table changed (workbench reloads `forge.plugin.list`). */
    'forge/plugins-changed': {}
    /** Host→renderer: mount or replace one generated renderer half. */
    'forge/gen-mounted': GenFace
    /** Host→renderer: unload one generated renderer half. */
    'forge/gen-unmounted': { id: string }
  }
}

/** One streaming session update (a discriminated union on `kind`). */
export type SessionDelta =
  | { kind: 'text', sessionId: string, text: string }
  | { kind: 'tool', sessionId: string, tool: string, phase: 'start' | 'end', input?: unknown, output?: unknown, ok?: boolean }
  | { kind: 'state', sessionId: string, state: 'running' | 'idle' | 'error', message?: string }

const emptyRequest = z.object({}).strict()

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,38}$/, 'plugin ids are 2-39 char lowercase kebab strings')

/** Request schemas for the forge domain's methods (ride with registration). */
export const forgeRequestSchemas = {
  'forge.session.list': emptyRequest,
  'forge.session.messages': z.object({ sessionId: z.string().min(1) }).strict(),
  'forge.session.send': z.object({
    sessionId: z.string().min(1).optional(),
    text: z.string().min(1).max(16_000),
    focusPluginId: idSchema.optional(),
  }).strict(),
  'forge.session.stop': z.object({ sessionId: z.string().min(1) }).strict(),
  'forge.plugin.list': emptyRequest,
  'forge.plugin.read': z.object({ id: idSchema, versionId: z.string().min(1).optional() }).strict(),
  'forge.plugin.set-enabled': z.object({ id: idSchema, enabled: z.boolean() }).strict(),
  'forge.plugin.set-version': z.object({ id: idSchema, versionId: z.string().regex(/^v\d+$/) }).strict(),
  'forge.plugin.remove': z.object({ id: idSchema }).strict(),
  'forge.client-report': z.object({
    id: idSchema,
    versionId: z.string().min(1),
    stage: z.enum(['load', 'render']),
    ok: z.boolean(),
    message: z.string().max(8_000).optional(),
  }).strict(),
  'forge.gen-faces': emptyRequest,
} as const

/** Payload schema of the `forge/session-delta` frame. */
export const sessionDeltaSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    sessionId: z.string().min(1),
    text: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('tool'),
    sessionId: z.string().min(1),
    tool: z.string().min(1),
    phase: z.enum(['start', 'end']),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    ok: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('state'),
    sessionId: z.string().min(1),
    state: z.enum(['running', 'idle', 'error']),
    message: z.string().optional(),
  }).strict(),
])

/** Payload schema of the `forge/plugins-changed` frame (a reload nudge). */
export const pluginsChangedSchema = z.object({}).strict()

/** Payload schema of the `forge/gen-mounted` frame. */
export const genMountedSchema = z.object({
  id: idSchema,
  versionId: z.string().min(1),
  src: z.string(),
}).strict()

/** Payload schema of the `forge/gen-unmounted` frame. */
export const genUnmountedSchema = z.object({ id: idSchema }).strict()
