/**
 * The generated-plugin and session registry: the durable version model over
 * `data/forge.db` plus the in-memory mount board the runner and dispatcher
 * report into. Versions are immutable and append-only; `currentSeq` is the
 * activation pointer (run/update/rollback only ever move it); `enabled`
 * decides whether boot remounts. Runtime status and diagnostics live on the
 * board, not in the database — they describe this process, not the artifact.
 *
 * @module @snap-rail/forge/registry
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { StoreDatabase } from '@snap-rail/store'
import type {
  GeneratedPluginInfo,
  GeneratedPluginStatus,
  SessionMessage,
  SessionSummary,
} from './contract.ts'
import { messages, plugins, sessions, versions, FORGE_SCHEMA } from './tables.ts'

/** A db handle bound to the forge namespace's tables. */
export type ForgeDb = StoreDatabase<typeof FORGE_SCHEMA>

/** One immutable version row as `readVersion` hands it back. */
export interface VersionRecord {
  pluginId: string
  seq: number
  versionId: string
  summary: string
  hostSrc: string | null
  clientSrc: string | null
  createdAt: number
}

/** A plugin's full record: the merged info plus its version history. */
export interface PluginRecord {
  info: GeneratedPluginInfo
  versions: Array<{ versionId: string, summary: string, createdAt: number, hasHost: boolean, hasClient: boolean }>
}

/** What a new definition carries into {@link ForgeRegistry.definePlugin}. */
export interface DefineInput {
  /** `new` creates the instance; `existing` appends a version. */
  kind: 'new' | 'existing'
  /** The stable plugin id (kebab); ignored for `existing` rows that exist. */
  id: string
  title: string
  description?: string | undefined
  summary: string
  hostSrc: string | null
  clientSrc: string | null
}

/**
 * Construct the registry over the db. All state rides construction-time
 * closures (the uiSlots lesson: traceable proxies rebind `this` per access).
 */
export function createRegistry(db: ForgeDb): ForgeRegistry {
  // The mount board: this process's runtime view, keyed by plugin id.
  const boardStatus = new Map<string, GeneratedPluginStatus>()
  const boardDiagnostics = new Map<string, string | null>()

  const versionIdOf = (seq: number): string => `v${seq}`

  const pluginRow = (id: string) =>
    db.select().from(plugins).where(eq(plugins.id, id)).get()

  const toInfo = (row: typeof plugins.$inferSelect): GeneratedPluginInfo => {
    const count = db.select({
      count: sql<number>`count(*)`,
    }).from(versions).where(eq(versions.pluginId, row.id)).get()
    const hasClient = row.currentSeq === null ? false
      : db.select({ src: versions.clientSrc }).from(versions)
        .where(and(eq(versions.pluginId, row.id), eq(versions.seq, row.currentSeq))).get()?.src !== null
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      enabled: row.enabled,
      status: boardStatus.get(row.id) ?? (row.enabled && row.currentSeq !== null ? 'running' : 'stopped'),
      currentVersionId: row.currentSeq === null ? null : versionIdOf(row.currentSeq),
      versionCount: count?.count ?? 0,
      diagnostics: boardDiagnostics.get(row.id) ?? null,
      hasClient,
    }
  }

  return {
    // ---- sessions ----
    createSession(title: string): SessionSummary {
      const now = Date.now()
      const id = `s${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
      db.insert(sessions).values({ id, title: title.slice(0, 80), createdAt: now, updatedAt: now }).run()
      return { id, title: title.slice(0, 80), createdAt: now, updatedAt: now }
    },
    listSessions(): SessionSummary[] {
      return db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all()
        .map(row => ({ id: row.id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt }))
    },
    sessionExists(id: string): boolean {
      return db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get() !== undefined
    },
    appendMessage(sessionId: string, role: SessionMessage['role'], content: string, meta?: unknown): void {
      const last = db.select({ seq: messages.seq }).from(messages)
        .where(eq(messages.sessionId, sessionId)).orderBy(desc(messages.seq)).limit(1).get()
      const seq = (last?.seq ?? 0) + 1
      db.insert(messages).values({
        sessionId,
        seq,
        role,
        content,
        meta: meta === undefined ? null : JSON.stringify(meta),
        createdAt: Date.now(),
      }).run()
      db.update(sessions).set({ updatedAt: Date.now() }).where(eq(sessions.id, sessionId)).run()
    },
    listMessages(sessionId: string): SessionMessage[] {
      return db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.seq)).all()
        .map(row => ({
          seq: row.seq,
          role: row.role as SessionMessage['role'],
          text: row.content,
          ...(row.meta !== null ? { meta: JSON.parse(row.meta) as unknown } : {}),
        }))
    },

    // ---- plugins ----
    definePlugin(input: DefineInput): { pluginId: string, versionId: string } {
      const now = Date.now()
      let id = input.id
      if (input.kind === 'new') {
        if (pluginRow(input.id) !== undefined) {
          throw new Error(`插件 "${input.id}" 已存在；修改请用 kind:"existing" 追加新版本`)
        }
        db.insert(plugins).values({
          id,
          title: input.title,
          description: input.description ?? '',
          enabled: true,
          currentSeq: null,
          createdAt: now,
        }).run()
      } else {
        const existing = pluginRow(input.id)
        if (existing === undefined) {
          throw new Error(`插件 "${input.id}" 不存在；新插件请用 kind:"new"`)
        }
        id = existing.id
      }
      const last = db.select({ seq: versions.seq }).from(versions)
        .where(eq(versions.pluginId, id)).orderBy(desc(versions.seq)).limit(1).get()
      const seq = (last?.seq ?? 0) + 1
      db.insert(versions).values({
        pluginId: id,
        seq,
        summary: input.summary,
        hostSrc: input.hostSrc,
        clientSrc: input.clientSrc,
        createdAt: now,
      }).run()
      return { pluginId: id, versionId: versionIdOf(seq) }
    },
    listPlugins(): GeneratedPluginInfo[] {
      return db.select().from(plugins).orderBy(asc(plugins.createdAt)).all().map(toInfo)
    },
    readPlugin(id: string): PluginRecord | undefined {
      const row = pluginRow(id)
      if (row === undefined) return undefined
      const history = db.select().from(versions).where(eq(versions.pluginId, id)).orderBy(desc(versions.seq)).all()
      return {
        info: toInfo(row),
        versions: history.map(version => ({
          versionId: versionIdOf(version.seq),
          summary: version.summary,
          createdAt: version.createdAt,
          hasHost: version.hostSrc !== null,
          hasClient: version.clientSrc !== null,
        })),
      }
    },
    readVersion(id: string, versionId: string): VersionRecord | undefined {
      const seq = parseVersionId(versionId)
      if (seq === null) return undefined
      const row = db.select().from(versions)
        .where(and(eq(versions.pluginId, id), eq(versions.seq, seq))).get()
      if (row === undefined) return undefined
      return {
        pluginId: row.pluginId,
        seq: row.seq,
        versionId: versionIdOf(row.seq),
        summary: row.summary,
        hostSrc: row.hostSrc,
        clientSrc: row.clientSrc,
        createdAt: row.createdAt,
      }
    },
    setCurrent(id: string, versionId: string): boolean {
      const seq = parseVersionId(versionId)
      if (seq === null) return false
      if (db.select({ seq: versions.seq }).from(versions)
        .where(and(eq(versions.pluginId, id), eq(versions.seq, seq))).get() === undefined) return false
      db.update(plugins).set({ currentSeq: seq }).where(eq(plugins.id, id)).run()
      return true
    },
    setEnabled(id: string, enabled: boolean): boolean {
      if (pluginRow(id) === undefined) return false
      db.update(plugins).set({ enabled }).where(eq(plugins.id, id)).run()
      return true
    },
    remove(id: string): boolean {
      if (pluginRow(id) === undefined) return false
      db.delete(versions).where(eq(versions.pluginId, id)).run()
      db.delete(plugins).where(eq(plugins.id, id)).run()
      boardStatus.delete(id)
      boardDiagnostics.delete(id)
      return true
    },
    /** Enabled plugins with an activation pointer — exactly what boot remounts. */
    remountList(): Array<{ id: string, currentVersionId: string, hostSrc: string | null, clientSrc: string | null }> {
      return db.select().from(plugins).where(eq(plugins.enabled, true)).all()
        .flatMap(row => {
          if (row.currentSeq === null) return []
          const version = db.select().from(versions)
            .where(and(eq(versions.pluginId, row.id), eq(versions.seq, row.currentSeq))).get()
          if (version === undefined) return []
          return [{
            id: row.id,
            currentVersionId: versionIdOf(version.seq),
            hostSrc: version.hostSrc,
            clientSrc: version.clientSrc,
          }]
        })
    },

    // ---- mount board ----
    setStatus(id: string, status: GeneratedPluginStatus, diagnostics?: string | null): void {
      boardStatus.set(id, status)
      if (diagnostics !== undefined) boardDiagnostics.set(id, diagnostics)
    },
    clearBoard(id: string): void {
      boardStatus.delete(id)
      boardDiagnostics.delete(id)
    },
  }
}

/** The registry's public face. */
export interface ForgeRegistry {
  /** Create a session titled after the first turn. */
  createSession(title: string): SessionSummary
  /** Sessions newest-first by activity. */
  listSessions(): SessionSummary[]
  /** Whether the session id exists. */
  sessionExists(id: string): boolean
  /** Append one turn; assigns the next seq and touches the session. */
  appendMessage(sessionId: string, role: SessionMessage['role'], content: string, meta?: unknown): void
  /** The conversation log, oldest-first. */
  listMessages(sessionId: string): SessionMessage[]
  /** Append one immutable version (`new` also creates the plugin row). */
  definePlugin(input: DefineInput): { pluginId: string, versionId: string }
  /** The merged plugin table (db rows joined with the mount board). */
  listPlugins(): GeneratedPluginInfo[]
  /** One plugin's info plus version history (newest-first). */
  readPlugin(id: string): PluginRecord | undefined
  /** One version's full record, sources included. */
  readVersion(id: string, versionId: string): VersionRecord | undefined
  /** Move the activation pointer; `false` when plugin or version is unknown. */
  setCurrent(id: string, versionId: string): boolean
  /** Flip the boot-remount flag; `false` when the plugin is unknown. */
  setEnabled(id: string, enabled: boolean): boolean
  /** Drop the plugin row, its versions, and its board entries. */
  remove(id: string): boolean
  /** Enabled plugins with a live pointer — what boot remounts. */
  remountList(): Array<{ id: string, currentVersionId: string, hostSrc: string | null, clientSrc: string | null }>
  /** Record runtime state on the mount board (renderer- or host-side). */
  setStatus(id: string, status: GeneratedPluginStatus, diagnostics?: string | null): void
  /** Forget a plugin's board entries (after remove). */
  clearBoard(id: string): void
}

/** Parse `v<seq>` back to its number, `null` when malformed. */
function parseVersionId(versionId: string): number | null {
  const match = /^v(\d+)$/.exec(versionId)
  if (match === null) return null
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null
}
