/**
 * The plugins and update domains' wire contracts: layer administration,
 * the plugin feed, offline combo archives, and the app-update channel. This module is the merge
 * point — programs importing it (the bridges, the settings pages, tests)
 * see the rows in the protocol's open `RpcMethodMap`/`FrameMap`; everyone
 * else stays untyped.
 *
 * @module @snap-rail/app-boot/contract
 */

import { z } from 'zod'
import { defineContract, method } from '@snap-rail/protocol'
import type { FrameRows, MethodRows } from '@snap-rail/protocol'

/** Where a plugin row comes from in the merged view. */
export type PluginSource = 'builtin' | 'preset' | 'user' | 'pool'

/** One plugin as the management surface sees it. */
export interface PluginInfo {
  /** Package name (or subpath entry) — also the entry id in the composed list. */
  name: string
  /** Origin: shipped layer, a preset row (no user override), a user-layer
   * insert, or available-in-pool only. */
  source: PluginSource
  /** Whether it is currently mounted (`false` covers disabled and unreferenced pool plugins). */
  enabled: boolean
  /** The npm package the row belongs to (`@scope/pkg` of `@scope/pkg/sub`) —
   * rows of one package render as one group under one master toggle. */
  packageName: string
  /** The package's declared kind (`snapRail.kind`). */
  kind?: string
  /** The pool package's declared version (pool-sourced rows only). */
  version?: string
  /** The package's declared layer (`snapRail.layer`); shipped rows accept no
   * UI or RPC operation — replacement is a source rebuild. */
  layer?: string
  /** The author-named display name (`snapRail.title`); listing surfaces show
   * it with the package name as the secondary line, falling back to the
   * package name alone when undeclared. */
  title?: string
  /** The author-named classification marker (`snapRail.category`); the
   * management UI groups rows by the raw string. */
  category?: string
  /** The mutex group (`snapRail.exclusive`, or the kind default): enabling a
   * package of group X disables every other enabled member of X. */
  exclusive?: string
  /** True when the package has no host face (`snapRail.clientOnly`): its rows
   * are renderer-only, enabled state applies after a restart. */
  clientOnly?: boolean
  /**
   * Declared dependencies (`snapRail.requires`) — the single compatibility
   * declaration: package names, `name@range` version-constrained packages
   * (a renderer face's framework binding IS such an entry), and `service:`
   * ids checked before enable/disable/uninstall land.
   */
  requires?: readonly string[]
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** The publisher key id after archive verification. */
  signatureKeyId?: string | undefined
  /** The entry's current config when one is set. */
  config?: unknown
}

/** How installing one inspected zip would land over the current pool. */
export type InstallAction =
  /** Not installed — a fresh install. */
  | 'install'
  /** Installed at a strictly lower version — an in-place update. */
  | 'update'
  /** Installed at an equal or higher version — the install will be refused. */
  | 'blocked'

/** Runtime shape of the installer's three-state signature verdict. */
export const pluginSignatureSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('verified'), keyId: z.string().min(1), publisher: z.string().min(1).optional() }).strict(),
  z.object({ state: z.literal('unverified'), keyId: z.string().min(1).optional(), reason: z.enum(['unsigned', 'unknown-key']) }).strict(),
])

/** How the signature gate judged one archive. `publisher` only ever comes
 * from the local trust file (a publisher claimed inside the zip is attacker
 * controlled and never displayed); `keyId` on an unverified verdict is the
 * envelope's own claim — shown as-is, trusted by nobody. */
export type PluginSignature = z.output<typeof pluginSignatureSchema>

/** How installing one feed entry (or one combo member) would land over the
 * current pool. */
export type RemoteAction =
  /** Not installed — a fresh install. */
  | 'install'
  /** Installed at a strictly lower version — an in-place update. */
  | 'update'
  /** The installed version equals the feed's. */
  | 'current'
  /** The installed version is newer than the feed's. */
  | 'local-newer'

/** One plugin as a plugin feed's catalog lists it. */
export interface RemotePluginInfo {
  /** Package name — the install identity in the pool. */
  name: string
  /** The feed's latest version. */
  version: string
  /** Human description carried from the release manifest. */
  description?: string | undefined
  /** The package's declared kind (`snapRail.kind`), when declared. */
  kind?: string | undefined
  /** The author-named display name (`snapRail.title`), when declared. */
  title?: string | undefined
  /** The author-named classification marker (`snapRail.category`), when
   * declared — the plugins page groups rows by the raw string. */
  category?: string | undefined
  /** Declared dependencies (`snapRail.requires`), when declared — also the
   * machine-readable trace of which base the plugin builds on. */
  requires?: readonly string[] | undefined
  /** The zip's file name relative to its feed — present for same-directory
   * entries; federation entries carry `url` instead. The host resolves it
   * only against the entry's feed, so the wire never turns a relative name
   * into an arbitrary location. */
  file?: string | undefined
  /** Absolute http(s) address of the zip — the federation form: an
   * aggregator lists a community plugin without collecting its bytes, and
   * the download goes to the author's own release (still sha256-checked
   * against the entry's digest). */
  url?: string | undefined
  /** The entry feed's display label (its catalog `title`, else its host
   * name) — multi-source searches merge, so rows carry where they came from. */
  source?: string | undefined
  /** The feed base this entry was listed by (where a relative `file`
   * downloads from). */
  feedUrl?: string | undefined
  /** The zip's mandatory sha256 hex digest; a differing download is refused
   * before it reaches the installer. */
  sha256?: string | undefined
  /** The zip's mandatory byte size. */
  size?: number | undefined
  /** Mandatory signature metadata published with the release. */
  signature?: { algorithm: 'Ed25519', keyId: string } | undefined
  engines?: { snapRail?: string | undefined, hostProtocol?: string | undefined, renderer?: string | undefined } | undefined
  /** The installed version when the package is already in the pool. */
  installed?: { version: string } | undefined
  action: RemoteAction
}

/** What a zip inspection reports: the install-time confirmation surface,
 * including how the install would land against the installed version. */
export interface InspectedPlugin {
  name: string
  version: string
  kind?: string | undefined
  title?: string | undefined
  category?: string | undefined
  permissions: readonly string[]
  /** Whether the package declares a renderer face (`snapRail.client`). */
  hasClient: boolean
  /** Declared dependencies from the manifest, unfiltered. */
  requires: readonly string[]
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** The three-state signature verdict (the 签名 row; `unverified` drives
   * the confirmation dialog's extra risk step). */
  signature: PluginSignature
  /** Package requirements the home cannot satisfy (not installed) — the
   * confirmation dialog shows these as warnings. */
  missing: readonly string[]
  /** The installed version when the package is already in the pool. */
  installed?: { version: string } | undefined
  /** How the install would land over that version. */
  action: InstallAction
}

/** A combo's kind: `base` combinations are the standard install units (the
 * shared target bench third-party plugins build against); `scenario`
 * combinations stack scenario plugins on a base to demonstrate an effect. */
export type RecipeKind = 'base' | 'scenario'

/** One plugin package inside an inspected combo archive. */
export interface InspectedComboPlugin {
  /** Package name from the member zip's manifest — the pool install identity. */
  name: string
  version: string
  kind?: string | undefined
  title?: string | undefined
  category?: string | undefined
  /** The member's declared permissions (the risk card's list). */
  permissions: readonly string[]
  /** Whether the member declares a renderer face (`snapRail.client`). */
  hasClient: boolean
  /** The member's own three-state release signature verdict. */
  signature: PluginSignature
  /** The installed version when the package is already in the pool. */
  installed?: { version: string } | undefined
  /** How the member would land: `current` and `local-newer` are skipped —
   * a combo never reinstalls the same version or downgrades a local copy. */
  action: RemoteAction
}

/** What a combo archive inspection reports: the archive is a plain zip
 * carrying `recipe.yml` plus one signed plugin zip per referenced package.
 * There is no archive-level signature — every member keeps its own release
 * signature (verified above), which is what the installer gates on. */
export interface InspectedCombo {
  /** Stable id; also the preset file name (`recipe-<id>.yml`). */
  id: string
  /** The combo document's version (bumped when its rows change). */
  version: string
  /** Human title (`标准基座`, `产线看板`, …). */
  title: string
  kind: RecipeKind
  /** One-line description of the combination's effect. */
  description?: string | undefined
  /** The member packages in the combo document's row order. */
  plugins: readonly InspectedComboPlugin[]
  /** Package requirements no member or installed package can satisfy — the
   * confirmation dialog shows these as warnings; install refuses on them
   * because the preset enables every row immediately. */
  missing: readonly string[]
  /** Whether any member carries a renderer face (the install lands a UI). */
  hasClient: boolean
}

/** What `plugins.inspect` / `plugins.inspect-from-url` report: the archive
 * URL did not say whether it is a plugin or a combo — the bytes do, and the
 * branch decides which install method lands it. */
export type InspectedArchive =
  | { kind: 'plugin', plugin: InspectedPlugin }
  | { kind: 'combo', combo: InspectedCombo }

/** Host snapshot used by the kernel recovery surface and support bundles. */
export interface PluginDiagnostics {
  host: { snapRail: string, hostProtocol: string, renderer: string }
  enabled: readonly string[]
  missing: readonly { name: string, requirements: readonly string[] }[]
  signatures: readonly { name: string, keyId: string }[]
  lastFailure: { time: number, message: string } | null
}

/** Runtime validator shared by the kernel recovery surface and Host RPC. */
export const pluginDiagnosticsSchema = z.object({
  host: z.object({ snapRail: z.string(), hostProtocol: z.string(), renderer: z.string() }).strict(),
  enabled: z.array(z.string()),
  missing: z.array(z.object({
    name: z.string(),
    requirements: z.array(z.string()),
  }).strict()),
  signatures: z.array(z.object({ name: z.string(), keyId: z.string() }).strict()),
  lastFailure: z.object({ time: z.number(), message: z.string() }).strict().nullable(),
}).strict()

/** Payload schema of the `plugins/updates-changed` frame: the pending
 * update set (keyChanged rows stay pending — the auto apply skips them). */
export const pluginUpdatesChangedSchema = z.object({
  updates: z.array(z.object({
    name: z.string().min(1),
    installedVersion: z.string().min(1),
    feedVersion: z.string().min(1),
    title: z.string().optional(),
    /** The feed entry's signing key differs from the key the installed copy
     * carries — an auto apply never touches it; a manual update confirms. */
    keyChanged: z.boolean().optional(),
  }).strict()),
}).strict()

/** One pending plugin update (the frame's entry shape). */
export type PluginUpdate = z.output<typeof pluginUpdatesChangedSchema>['updates'][number]

declare module '@snap-rail/cordis' {
  interface Events {
    /** The auto-update sweep (or an apply) changed the pending update set
     * (the renderer-facing projection of the `plugins/updates-changed`
     * frame).
     *
     * @param updates - the pending updates; empty once an apply lands. */
    'plugins/updates-changed'(updates: readonly PluginUpdate[]): void
  }
}

/** One wire method of the plugins domain, from its declaration to its
 * handler: the merged `RpcMethodMap` rows, the trust-boundary request
 * schemas, and the handler table all derive from this one declaration. */
export const pluginsContract = defineContract('plugins', {
  methods: {
    /** Merged view: mounted entries with status plus pool plugins not referenced. */
    'plugins.list': method(z.object({}).strict()).ret<{ plugins: readonly PluginInfo[] }>(),
    /** Read the current Host/Renderer/plugin health snapshot without mutating layers. */
    'plugins.diagnostics': method(z.object({}).strict()).ret<{ snapshot: PluginDiagnostics }>(),
    /** Enable or disable one plugin by writing a user-layer row and hot-applying. */
    'plugins.set-enabled': method(z.object({
      name: z.string().min(1),
      enabled: z.boolean(),
    }).strict()).ret<{ applied: true }>(),
    /** Replace one plugin's config through a user-layer row and hot-apply. */
    'plugins.set-config': method(z.object({
      name: z.string().min(1),
      config: z.unknown(),
    }).strict()).ret<{ applied: true }>(),
    /** Install a plugin zip into the pool (validate → extract → compose);
     * over an installed package, only a strictly higher version updates. */
    'plugins.install': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ installed: { name: string, version: string, updated: boolean } }>(),
    /** Peek at a plugin or combo zip: a plugin reports identity/category/
     * permissions/dependencies and how it would land against the installed
     * version; a combo reports its members' own identity, signatures and
     * landing actions plus the aggregate unsatisfied requirements. No
     * extraction into the pool, no layer writes. */
    'plugins.inspect': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ archive: InspectedArchive }>(),
    /** Download a plugin or combo zip from an operator-supplied direct
     * http(s) URL (bounded: one timeout, one size ceiling) and run the same
     * inspection as `plugins.inspect`; the returned `zipPath` feeds a
     * subsequent `plugins.install` (plugin) or `plugins.install-combo`
     * (combo) — a bare URL carries no digest, so integrity rides on the
     * release signatures the installer verifies (a combo's members each
     * carry their own). */
    'plugins.inspect-from-url': method(z.object({ url: z.string().min(1) }).strict())
      .ret<{ archive: InspectedArchive, zipPath: string }>(),
    /** Remove a pool package, its rows, and its namespaced data. */
    'plugins.uninstall': method(z.object({ name: z.string().min(1) }).strict())
      .ret<{ removed: true }>(),
    /** Fetch every configured feed's catalog, merge them (per name the
     * highest version wins; rows carry their source label), and annotate
     * how installing each entry would land against the local pool. */
    'plugins.remote-list': method(z.object({}).strict())
      .ret<{ plugins: readonly RemotePluginInfo[], feedUrls: readonly string[] }>(),
    /** Download one catalog entry's zip from the feed and install it (the
     * same strictly-higher update rule as a local install). */
    'plugins.remote-install': method(z.object({ name: z.string().min(1) }).strict())
      .ret<{ installed: { name: string, version: string, updated: boolean } }>(),
    /** Install an offline combo zip: every referenced package the pool lacks
     * (or holds at a strictly lower version) installs from the archive's own
     * member zips first; only after all of them land does the recipe's preset
     * file get written (which is what makes the combination live). A failure
     * restores both the pool and the previous preset. */
    'plugins.install-combo': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ installed: readonly { name: string, version: string, updated: boolean }[], preset: string }>(),
    /** Compare the installed pool against every configured feed: each
     * installed package whose highest feed version is strictly higher (the
     * same rule a manual update takes — never a downgrade, never a first
     * install). Built-ins never sit in the pool, so they never appear. */
    'plugins.updates-check': method(z.object({}).strict())
      .ret<{ updates: PluginUpdate[], feedUrls: readonly string[] }>(),
    /** Apply every pending update in one pool transaction: download
     * (sha256-verified), install (strictly-higher), hot-recompose — a
     * running terminal picks the new version up without a restart, and any
     * failure rolls the whole set back to the prior pool. */
    'plugins.auto-update-apply': method(z.object({}).strict())
      .ret<{ applied: readonly { name: string, from: string, to: string }[] }>(),
  },
  frames: {
    /** The pending update set changed: announced by the auto-update sweep
     * (and emptied once an apply lands). */
    'plugins/updates-changed': pluginUpdatesChangedSchema,
  },
})

/** The legal package-name shape the installer enforces (shared with the catalog). */
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * The `index.json` catalog a plugin feed serves: the packer emits it, the
 * host validates it before anything downstream sees an entry. Deliberately
 * non-strict for enrichment fields — unknown fields strip — while the
 * load-bearing release fields are mandatory (the file name pattern keeps
 * same-directory downloads under the feed base, and the digest, size, and
 * signature identify the exact zip the installer is allowed to consume).
 * A catalog may carry a `title` — the display label entries annotate from
 * in multi-source views. Federation entries replace the relative `file`
 * with an absolute `url` pointing at the author's own release: an
 * aggregator lists community plugins without collecting their bytes.
 */
export const remoteCatalogSchema = z.object({
  title: z.string().min(1).optional(),
  plugins: z.array(z.object({
    name: z.string().regex(packageNamePattern),
    version: z.string().min(1),
    description: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    category: z.string().optional(),
    requires: z.array(z.string()).optional(),
    // Scoped package archives are named `@scope__package.zip`; `@` is legal
    // only as the first character and no slash/path segment is accepted.
    file: z.string().regex(/^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:__[A-Za-z0-9][A-Za-z0-9._-]*)?\.zip$/).optional(),
    // The federation form: absolute http(s) only.
    url: z.string().regex(/^https?:\/\/\S+$/).optional(),
    // A feed catalog is a signed release index, not a convenience list:
    // every entry carries the exact zip digest, byte size, and release key id.
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
    signature: z.object({ algorithm: z.literal('Ed25519'), keyId: z.string().min(1) }),
    engines: z.object({ snapRail: z.string().min(1).optional(), hostProtocol: z.string().min(1).optional(), renderer: z.string().min(1).optional() }).strict().optional(),
  }).refine(row => row.file !== undefined || row.url !== undefined, { message: '条目需要 file（同场 zip）或 url（绝对地址）之一' })),
})

/** One validated feed catalog. */
export type RemoteCatalog = z.output<typeof remoteCatalogSchema>

/** The `settings.json` key holding the plugin feed's base URLs (the
 * multi-source list). The legacy singular `plugins.feedUrl` still reads as
 * a one-element list for transition. */
export const PLUGINS_FEED_URLS_KEY = 'plugins.feedUrls'
/** The legacy singular feed key — read-only, written by pre-multi-source
 * clients; a fresh save moves the value into `plugins.feedUrls`. */
export const PLUGINS_FEED_URL_KEY = 'plugins.feedUrl'
/** The `settings.json` key for the install-time signature gate: `strict`
 * requires trusted-publisher signatures; absent reads as `open`. */
export const PLUGINS_SIGNATURE_POLICY_KEY = 'plugins.signaturePolicy'

/** One app-update lifecycle snapshot: the full state every time, so frame
 * consumers render it directly instead of folding deltas. */
export interface UpdateStatus {
  phase:
    /** Not a packaged build (dev) — the channel cannot run. */
    | 'unsupported'
    /** Packaged, but no update source is configured. */
    | 'unconfigured'
    /** Connected to a source, nothing in flight. */
    | 'idle'
    | 'checking'
    /** A newer version exists (its download starts automatically). */
    | 'available'
    /** The running version is the newest. */
    | 'none'
    | 'downloading'
    /** Downloaded and staged — restart installs it. */
    | 'ready'
    | 'error'
  /** The running app's version (`app.getVersion()`). */
  currentVersion: string
  /** The incoming version once one is known (`available`/`downloading`/`ready`). */
  version?: string | undefined
  /** Download progress percentage while `downloading`. */
  percent?: number | undefined
  /** Human-readable detail for `error` and `unconfigured`. */
  message?: string | undefined
}

/** Payload schema of the `update/status` frame (client-side parsing). */
export const updateStatusSchema = z.object({
  phase: z.enum([
    'unsupported', 'unconfigured', 'idle', 'checking', 'available',
    'none', 'downloading', 'ready', 'error',
  ]),
  currentVersion: z.string(),
  version: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
}) satisfies z.ZodType<UpdateStatus>

/** The `settings.json` key overriding the packaged update source (a generic-provider URL). */
export const UPDATE_FEED_URL_KEY = 'update.feedUrl'
/** The `settings.json` key gating the startup auto-check (boolean, default on). */
export const UPDATE_AUTO_CHECK_KEY = 'update.autoCheck'

/** The app-update wire surface: check, watch the automatic download, and
 * install (restart) once staged. Backed by electron-updater in the desktop
 * shell; the snapshot rides the `update/status` frame. */
export const updateContract = defineContract('update', {
  methods: {
    /** The current snapshot (the page's mount read; live updates ride `update/status`). */
    'update.state': method(z.object({}).strict()).ret<{ status: UpdateStatus }>(),
    /** Check the configured source now; the snapshot afterwards rides the frames. */
    'update.check': method(z.object({}).strict()).ret<{ status: UpdateStatus }>(),
    /** Download a found update (also runs automatically after a check). */
    'update.download': method(z.object({}).strict()).ret<{ status: UpdateStatus }>(),
    /** Quit and install a staged update. */
    'update.install': method(z.object({}).strict()).ret<{ applied: true }>(),
  },
  frames: {
    'update/status': updateStatusSchema,
  },
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends
    MethodRows<typeof pluginsContract>,
    MethodRows<typeof updateContract> {}
  interface FrameMap extends FrameRows<typeof updateContract> {}
}
