/**
 * The forge domain's wire contract: creation sessions with the agent loop,
 * generated-plugin administration, and the host→renderer push of generated
 * renderer halves. One {@link defineContract} declaration is the single
 * source — programs importing this module (the host bridge, the workbench
 * pages, tests) see the rows in the protocol's open maps; everyone else
 * stays untyped. Pure face: zod + types only, no node imports, so the
 * client bundle may inline it.
 *
 * @module @snap-rail/forge/contract
 */

import { z } from 'zod'
import { defineContract, method } from '@snap-rail/protocol'
import type { FrameRows, MethodRows } from '@snap-rail/protocol'

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

/** One streaming session update (a discriminated union on `kind`). */
export type SessionDelta =
  | { kind: 'text', sessionId: string, text: string }
  | { kind: 'tool', sessionId: string, tool: string, phase: 'start' | 'end', input?: unknown, output?: unknown, ok?: boolean }
  | { kind: 'state', sessionId: string, state: 'running' | 'idle' | 'error', message?: string }

const emptyRequest = z.object({}).strict()

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{1,38}$/, 'plugin ids are 2-39 char lowercase kebab strings')

const versionIdSchema = z.string().regex(/^v\d+$/)

// --- frame payload schemas (also consumed by name on the renderer side) ---

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

/**
 * The forge wire surface: every mutation paths through the same activation
 * semantics for the model and the operator alike; frames stream the agent
 * run and the generated-plugin lifecycle.
 */
export const forgeContract = defineContract('forge', {
  methods: {
    'forge.session.list': method(emptyRequest).ret<{ sessions: readonly SessionSummary[] }>(),
    'forge.session.messages': method(z.object({ sessionId: z.string().min(1) }).strict())
      .ret<{ messages: readonly SessionMessage[] }>(),
    /** Send one user turn; the agent run is asynchronous (progress rides frames).
     * A missing `sessionId` creates the session. `focusPluginId` injects that
     * plugin's identity, current version, and diagnostics into the turn. */
    'forge.session.send': method(z.object({
      sessionId: z.string().min(1).optional(),
      text: z.string().min(1).max(16_000),
      focusPluginId: idSchema.optional(),
    }).strict()).ret<{ sessionId: string, started: true }>(),
    /** Abort the session's in-flight agent run (the turn stays unfinished). */
    'forge.session.stop': method(z.object({ sessionId: z.string().min(1) }).strict())
      .ret<{ stopped: boolean }>(),
    /** Delete a session and its messages; refuses the session whose agent run is in flight. */
    'forge.session.remove': method(z.object({ sessionId: z.string().min(1) }).strict())
      .ret<{ removed: true }>(),

    'forge.plugin.list': method(emptyRequest).ret<{ plugins: readonly GeneratedPluginInfo[] }>(),
    /** One plugin's version history and sources (the source-view dialog). */
    'forge.plugin.read': method(z.object({ id: idSchema, versionId: z.string().min(1).optional() }).strict())
      .ret<{
        info: GeneratedPluginInfo
        versions: ReadonlyArray<{ versionId: string, summary: string, createdAt: number, hasHost: boolean, hasClient: boolean }>
        version: { versionId: string, summary: string, hostSrc: string | null, clientSrc: string | null }
      }>(),
    /** Enable/disable a plugin — mounts or unmounts both halves immediately. */
    'forge.plugin.set-enabled': method(z.object({ id: idSchema, enabled: z.boolean() }).strict())
      .ret<{ applied: true }>(),
    /** Activate a specific version (rollback = an older versionId). */
    'forge.plugin.set-version': method(z.object({ id: idSchema, versionId: versionIdSchema }).strict())
      .ret<{ applied: true }>(),
    /** Permanently remove a plugin and its version history. */
    'forge.plugin.remove': method(z.object({ id: idSchema }).strict()).ret<{ removed: true }>(),
    /** Package one plugin version as an installable zip (the release format)
     * at the host-side path the save dialog returned. */
    'forge.plugin.export': method(z.object({
      id: idSchema,
      versionId: versionIdSchema.optional(),
      path: z.string().min(1).max(1024),
    }).strict()).ret<{ path: string }>(),

    /** The renderer runner's callback channel (load/render diagnostics, host-fed). */
    'forge.client-report': method(z.object({
      id: idSchema,
      versionId: z.string().min(1),
      stage: z.enum(['load', 'render']),
      ok: z.boolean(),
      message: z.string().max(8_000).optional(),
    }).strict()).ret<{ received: true }>(),

    /** The renderer's boot-time pull of every enabled plugin's renderer half. */
    'forge.gen-faces': method(emptyRequest).ret<{ faces: readonly GenFace[] }>(),
  },
  frames: {
    /** Streaming session updates: assistant text, tool cards, run state. */
    'forge/session-delta': sessionDeltaSchema,
    /** The generated-plugin table changed (workbench reloads `forge.plugin.list`). */
    'forge/plugins-changed': pluginsChangedSchema,
    /** Host→renderer: mount or replace one generated renderer half. */
    'forge/gen-mounted': genMountedSchema,
    /** Host→renderer: unload one generated renderer half. */
    'forge/gen-unmounted': genUnmountedSchema,
  },
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof forgeContract> {}
  interface FrameMap extends FrameRows<typeof forgeContract> {}
}
