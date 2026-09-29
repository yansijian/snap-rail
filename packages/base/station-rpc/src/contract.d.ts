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
import { z } from 'zod';
import type { FrameRows, MethodRows } from '@snap-rail/protocol';
import type { AuditEntry } from '@snap-rail/audit';
/** One audit record on the wire; the audit service entry is the single
 * source (no mirror type). */
export type AuditEntryInfo = AuditEntry;
/** Settings key holding the signed-on operator id (`null` when signed off).
 * Shared by the host bridge (writer) and renderer mirrors (follower). */
export declare const SESSION_OPERATOR_KEY = "session.operatorId";
/** Settings key toggling the renderer's auto-reload on plugin-row changes
 * (`false` disables; absent means on — the operator terminal's default). */
export declare const RENDERER_AUTO_RELOAD_KEY = "ui.rendererAutoReload";
/** A settings key: a lowercase domain prefix, a dot, and a non-empty name
 * (e.g. `session.operatorId`, `production.countBinding`). */
export declare const settingsKeySchema: z.ZodString;
/** One renderer-occupant row carved out of the user layer. */
export interface ClientConfigRow {
    /** Renderer occupant package name (the row key). */
    name: string;
    /**
     * Whether the occupant mounts. Renderer rows: the row's flag (absent rows
     * are enabled). Pool faces: explicit enable only — a rowless pool plugin
     * lists as disabled until the user turns it on.
     */
    enabled: boolean;
    /** The occupant's config when the row carries one. */
    config?: unknown;
    /** Pool-installed occupants: the bundle URL the renderer's module loader
     * fetches (`snap-plugin://pool/…`); shipped occupants mount from the app
     * bundle instead. */
    clientUrl?: string;
    /** The package's declared kind (`snapRail.kind`) — `framework` rows load
     * before every other face (they provide the contributed seeds). */
    kind?: string | undefined;
    /** The author-named classification marker, for display. */
    category?: string | undefined;
    /** Contributed-seed subpaths (`snapRail.client.seeds`) — non-empty rows
     * are seed providers and load before plain occupant faces. */
    seeds?: readonly string[] | undefined;
}
/** Payload schema of the `settings/changed` frame. */
export declare const settingsChangedSchema: z.ZodObject<{
    key: z.ZodString;
    value: z.ZodUnknown;
}, z.core.$strict>;
/** Payload schema of the `client-config/changed` frame (a reload nudge). */
export declare const clientConfigChangedSchema: z.ZodObject<{}, z.core.$strict>;
/**
 * The station wire surface: every write to settings.json broadcasts
 * `settings/changed` so renderer occupants hot-apply instead of waiting for
 * a restart; complex per-plugin config still lives in `plugins.yml`.
 */
export declare const stationContract: {
    readonly domain: string;
    readonly methods: {
        /** The signed-on operator, or `null` when the station waits at the login page. */
        readonly 'session.current': import("@snap-rail/protocol").MethodRow<z.ZodObject<{}, z.core.$strict>, {
            operator: string | null;
        }>;
        /** Sign an operator on (persisted across restarts); an empty id is a business failure. */
        readonly 'session.login': import("@snap-rail/protocol").MethodRow<z.ZodObject<{
            operator: z.ZodString;
        }, z.core.$strict>, {
            applied: true;
        }>;
        /** Sign the current operator off. */
        readonly 'session.logout': import("@snap-rail/protocol").MethodRow<z.ZodObject<{}, z.core.$strict>, {
            applied: true;
        }>;
        /** Read one settings key's value; `null` when the key was never set. */
        readonly 'settings.get': import("@snap-rail/protocol").MethodRow<z.ZodObject<{
            key: z.ZodString;
        }, z.core.$strict>, {
            value: unknown;
        }>;
        /** Write one settings key and broadcast the change (`value`'s shape is
         * the consumer's contract). */
        readonly 'settings.set': import("@snap-rail/protocol").MethodRow<z.ZodObject<{
            key: z.ZodString;
            value: z.ZodUnknown;
        }, z.core.$strict>, {
            applied: true;
        }>;
        /** Read persisted audit entries, oldest-first; `limit` keeps the newest N. */
        readonly 'audit.list': import("@snap-rail/protocol").MethodRow<z.ZodObject<{
            actions: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
            actor: z.ZodOptional<z.ZodString>;
            since: z.ZodOptional<z.ZodNumber>;
            limit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, {
            entries: readonly AuditEntryInfo[];
        }>;
        /** Append one business event; the actor is the signed-on operator,
         * resolved host-side. */
        readonly 'audit.record': import("@snap-rail/protocol").MethodRow<z.ZodObject<{
            action: z.ZodString;
            subject: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strict>, {
            time: number;
        }>;
        /** Renderer-occupant configuration carved out of the shared `plugins.yml`. */
        readonly 'client-config.list': import("@snap-rail/protocol").MethodRow<z.ZodObject<{}, z.core.$strict>, {
            rows: readonly ClientConfigRow[];
        }>;
    };
    readonly frames: {
        /** Follows every settings.json write; consumers filter by key. */
        readonly 'settings/changed': z.ZodObject<{
            key: z.ZodString;
            value: z.ZodUnknown;
        }, z.core.$strict>;
        /** The plugin rows changed and the tree hot-applied — renderer windows
         * reload so occupant rows land without an operator restart. */
        readonly 'client-config/changed': z.ZodObject<{}, z.core.$strict>;
    };
};
declare module '@snap-rail/protocol' {
    interface RpcMethodMap extends MethodRows<typeof stationContract> {
    }
    interface FrameMap extends FrameRows<typeof stationContract> {
    }
}
//# sourceMappingURL=contract.d.ts.map