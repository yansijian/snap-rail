/**
 * The station domain's wire contract: operator session, settings key/value
 * persistence, business-event read/write over the audit log, and renderer
 * occupant config rows. One {@link defineContract} declaration is the
 * single source — programs importing this module (the bridge, renderer
 * residents, tests) see the rows in the protocol's open maps; everyone
 * else stays untyped.
 *
 * @module @snap-rail/station-rpc/contract
 */

import { z } from 'zod'
import { defineContract, method } from '@snap-rail/protocol'
import type { AuxSurfaceId, FrameRows, MethodRows } from '@snap-rail/protocol'
import type { AuditEntry } from '@snap-rail/audit'

/** One audit record on the wire; the audit service entry is the single
 * source (no mirror type). */
export type AuditEntryInfo = AuditEntry

/** Settings key holding the signed-on operator id (`null` when signed off).
 * Shared by the host bridge (writer) and renderer mirrors (follower). */
export const SESSION_OPERATOR_KEY = 'session.operatorId'

/** Settings key toggling the renderer's auto-reload on plugin-row changes
 * (`false` disables; absent means on — the operator terminal's default). */
export const RENDERER_AUTO_RELOAD_KEY = 'ui.rendererAutoReload'

/** A settings key: a lowercase domain prefix, a dot, and a non-empty name
 * (e.g. `session.operatorId`, `production.countBinding`). */
export const settingsKeySchema = z.string().min(3).max(128).regex(
  /^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9_.-]+$/, 'settings keys are "domain.name" strings')

/** One renderer-occupant row carved out of the user layer. */
export interface ClientConfigRow {
  /** Renderer occupant package name (the row key). */
  name: string
  /**
   * Whether the occupant mounts. Renderer rows: the row's flag (absent rows
   * are enabled). Pool faces: explicit enable only — a rowless pool plugin
   * lists as disabled until the user turns it on.
   */
  enabled: boolean
  /** The occupant's config when the row carries one. */
  config?: unknown
  /** Pool-installed occupants: the bundle URL the renderer's module loader
   * fetches (`snap-plugin://pool/…`); shipped occupants mount from the app
   * bundle instead. */
  clientUrl?: string
  /**
   * Auxiliary-surface bundles the package ships, one loader URL per surface
   * (`snapRail.client.surfaces` resolved like `clientUrl`). A surface absent
   * here has no face of its own and shows the kernel's plain fallback page;
   * an auxiliary surface is never loaded from the main bundle.
   */
  surfaceUrls?: Readonly<Partial<Record<AuxSurfaceId, string>>> | undefined
  /** The package's declared kind (`snapRail.kind`) — `framework` rows load
   * before every other face (they provide the contributed seeds). */
  kind?: string | undefined
  /** The author-named classification marker, for display. */
  category?: string | undefined
  /** Contributed-seed subpaths (`snapRail.client.seeds`) — non-empty rows
   * are seed providers and load before plain occupant faces. */
  seeds?: readonly string[] | undefined
  /** The pack-stamped seed contract (`snapRail.client.seedAbi`) the face
   * was built against, when it declares one. The renderer boot compares it
   * against the list result's live table before loading the face. */
  seedAbi?: { revision: number, versions: Readonly<Record<string, string>> } | undefined
}

const emptyRequest = z.object({}).strict()

/** Payload schema of the `settings/changed` frame. */
export const settingsChangedSchema = z.object({ key: settingsKeySchema, value: z.unknown() }).strict()

/** Payload schema of the `client-config/changed` frame (a reload nudge). */
export const clientConfigChangedSchema = z.object({}).strict()

/**
 * The station wire surface: every write to settings.json broadcasts
 * `settings/changed` so renderer occupants hot-apply instead of waiting for
 * a restart; complex per-plugin config still lives in `plugins.yml`.
 */
export const stationContract = defineContract('station', {
  methods: {
    /** The signed-on operator, or `null` when the station waits at the login page. */
    'session.current': method(emptyRequest).ret<{ operator: string | null }>(),
    /** Sign an operator on (persisted across restarts); an empty id is a business failure. */
    'session.login': method(z.object({ operator: z.string().min(1) }).strict()).ret<{ applied: true }>(),
    /** Sign the current operator off. */
    'session.logout': method(emptyRequest).ret<{ applied: true }>(),
    /** Read one settings key's value; `null` when the key was never set. */
    'settings.get': method(z.object({ key: settingsKeySchema }).strict()).ret<{ value: unknown }>(),
    /** Write one settings key and broadcast the change (`value`'s shape is
     * the consumer's contract). */
    'settings.set': method(z.object({ key: settingsKeySchema, value: z.unknown() }).strict()).ret<{ applied: true }>(),
    /** Read persisted audit entries, oldest-first; `limit` keeps the newest N. */
    'audit.list': method(z.object({
      actions: z.array(z.string().min(1)).readonly().optional(),
      actor: z.string().min(1).optional(),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }).strict()).ret<{ entries: readonly AuditEntryInfo[] }>(),
    /** Append one business event; the actor is the signed-on operator,
     * resolved host-side. */
    'audit.record': method(z.object({
      action: z.string().min(1),
      subject: z.string().optional(),
      detail: z.unknown().optional(),
    }).strict()).ret<{ time: number }>(),
    /** Renderer-occupant configuration carved out of the shared `plugins.yml`.
     * `seedAbi` is the host's live seed table (revision + base-package
     * versions) the renderer boot checks each face's stamped declaration
     * against — a foreign-ABI face is skipped with a loud console error
     * instead of crashing the window. */
    'client-config.list': method(emptyRequest).ret<{
      rows: readonly ClientConfigRow[]
      seedAbi: { revision: number, versions: Readonly<Record<string, string>> }
    }>(),
  },
  frames: {
    /** Follows every settings.json write; consumers filter by key. */
    'settings/changed': settingsChangedSchema,
    /** The plugin rows changed and the tree hot-applied — renderer windows
     * reload so occupant rows land without an operator restart. */
    'client-config/changed': clientConfigChangedSchema,
  },
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof stationContract> {}
  interface FrameMap extends FrameRows<typeof stationContract> {}
}
