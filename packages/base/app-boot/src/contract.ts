/**
 * The plugins and update domains' wire contracts: layer administration,
 * the plugin market, and the app-update channel. This module is the merge
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
  /** The framework a renderer face binds to (`snapRail.framework`); a
   * component whose binding does not match the active framework does not
   * mount. */
  framework?: string
  /** True when the package has no host face (`snapRail.clientOnly`): its rows
   * are renderer-only, enabled state applies after a restart. */
  clientOnly?: boolean
  /** Declared dependencies (`snapRail.requires`): package names and
   * `service:` ids checked before enable/disable/uninstall land. */
  requires?: readonly string[]
  capabilities?: { provides?: readonly { id: string, version: string }[], requires?: readonly { id: string, range: string, optional?: boolean }[] }
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

/** How installing one market entry would land over the current pool. */
export type RemoteAction =
  /** Not installed — a fresh install. */
  | 'install'
  /** Installed at a strictly lower version — an in-place update. */
  | 'update'
  /** The installed version equals the feed's. */
  | 'current'
  /** The installed version is newer than the feed's. */
  | 'local-newer'

/** One plugin as the market (a plugin feed's catalog) lists it. */
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
   * declared — the market page groups rows by the raw string. */
  category?: string | undefined
  /** Declared dependencies (`snapRail.requires`), when declared — also the
   * machine-readable trace of which base the plugin builds on. */
  requires?: readonly string[] | undefined
  /** The renderer framework binding (`snapRail.framework`), when declared. */
  framework?: string | undefined
  /** The zip's file name relative to the feed — never a URL. The host
   * resolves it against the configured feed and nothing else, so the wire
   * never carries a client-chosen download location. */
  file: string
  /** The zip's mandatory sha256 hex digest; a differing download is refused
   * before it reaches the installer. */
  sha256?: string | undefined
  /** The zip's mandatory byte size. */
  size?: number | undefined
  /** Mandatory signature metadata published with the release. */
  signature?: { algorithm: 'Ed25519', keyId: string } | undefined
  /** Capabilities and engine ranges published with the release. */
  capabilities?: { provides?: readonly { id: string, version: string }[] | undefined, requires?: readonly { id: string, range: string, optional?: boolean | undefined }[] | undefined } | undefined
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
  capabilities?: { provides?: readonly { id: string, version: string }[], requires?: readonly { id: string, range: string, optional?: boolean }[] }
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** The publisher key id after archive verification. */
  signatureKeyId?: string | undefined
  /** Package requirements the home cannot satisfy (not installed) — the
   * confirmation dialog shows these as warnings. */
  missing: readonly string[]
  /** The installed version when the package is already in the pool. */
  installed?: { version: string } | undefined
  /** How the install would land over that version. */
  action: InstallAction
}

/** Host snapshot used by the kernel recovery surface and support bundles. */
export interface PluginDiagnostics {
  host: { snapRail: string, hostProtocol: string, renderer: string }
  enabled: readonly string[]
  missing: readonly { name: string, requirements: readonly string[], capabilities: readonly string[] }[]
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
    capabilities: z.array(z.string()),
  }).strict()),
  signatures: z.array(z.object({ name: z.string(), keyId: z.string() }).strict()),
  lastFailure: z.object({ time: z.number(), message: z.string() }).strict().nullable(),
}).strict()

/** Payload schema of the `plugins/updates-changed` frame: the pending
 * update set (empty once an apply lands). */
export const pluginUpdatesChangedSchema = z.object({
  updates: z.array(z.object({
    name: z.string().min(1),
    installedVersion: z.string().min(1),
    feedVersion: z.string().min(1),
    title: z.string().optional(),
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
    /** Peek at a zip's identity/category/permissions/dependencies and how it
     * would land (`action`) against the installed version — no extraction,
     * no pool writes; `missing` lists unsatisfied package requirements. */
    'plugins.inspect': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ plugin: InspectedPlugin }>(),
    /** Remove a pool package, its rows, and its namespaced data. */
    'plugins.uninstall': method(z.object({ name: z.string().min(1) }).strict())
      .ret<{ removed: true }>(),
    /** Fetch the configured plugin feed's catalog and annotate every entry
     * with how installing it would land against the local pool. */
    'plugins.remote-list': method(z.object({}).strict())
      .ret<{ plugins: readonly RemotePluginInfo[], feedUrl: string }>(),
    /** Download one catalog entry's zip from the feed and install it (the
     * same strictly-higher update rule as a local install). */
    'plugins.remote-install': method(z.object({ name: z.string().min(1) }).strict())
      .ret<{ installed: { name: string, version: string, updated: boolean } }>(),
    /** Fetch the feed's recipe catalog and annotate every combination with
     * what it would still install locally and whether it already landed. */
    'plugins.remote-recipes': method(z.object({}).strict())
      .ret<{ recipes: readonly RemoteRecipeInfo[], feedUrl: string }>(),
    /** Install one combination: every missing or outdated referenced plugin
     * downloads from the feed first; only after all of them land does the
     * recipe's preset file get written (which is what makes it live). */
    'plugins.remote-install-recipe': method(z.object({ id: z.string().regex(/^[a-z0-9-]+$/) }).strict())
      .ret<{ installed: readonly { name: string, version: string, updated: boolean }[], applied: true }>(),
    /** Remove one installed combination's preset file — the pool packages it
     * installed stay; uninstall them individually if desired. */
    'plugins.remove-recipe': method(z.object({ id: z.string().regex(/^[a-z0-9-]+$/) }).strict())
      .ret<{ removed: true }>(),
    /** Compare the installed pool against the configured feed: every
     * installed package whose feed version is strictly higher (the same
     * rule a manual update takes — never a downgrade, never a first
     * install). Built-ins never sit in the pool, so they never appear. */
    'plugins.updates-check': method(z.object({}).strict())
      .ret<{ updates: PluginUpdate[], feedUrl: string }>(),
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
 * downloads under the feed base, and the digest, size, and signature identify
 * the exact zip the installer is allowed to consume).
 */
export const remoteCatalogSchema = z.object({
  plugins: z.array(z.object({
    name: z.string().regex(packageNamePattern),
    version: z.string().min(1),
    description: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    category: z.string().optional(),
    requires: z.array(z.string()).optional(),
    framework: z.string().optional(),
    // Scoped package archives are named `@scope__package.zip`; `@` is legal
    // only as the first character and no slash/path segment is accepted.
    file: z.string().regex(/^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:__[A-Za-z0-9][A-Za-z0-9._-]*)?\.zip$/),
    // A market catalog is a signed release index, not a convenience list:
    // every entry carries the exact zip digest, byte size, and release key id.
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
    signature: z.object({ algorithm: z.literal('Ed25519'), keyId: z.string().min(1) }),
    capabilities: z.object({
      provides: z.array(z.object({ id: z.string().min(1), version: z.string().min(1) }).strict()).optional(),
      requires: z.array(z.object({ id: z.string().min(1), range: z.string().min(1), optional: z.boolean().optional() }).strict()).optional(),
    }).strict().optional(),
    engines: z.object({ snapRail: z.string().min(1).optional(), hostProtocol: z.string().min(1).optional(), renderer: z.string().min(1).optional() }).strict().optional(),
  })),
})

/** One validated feed catalog. */
export type RemoteCatalog = z.output<typeof remoteCatalogSchema>

/** A recipe's kind: `base` combinations are the standard install units (the
 * shared target bench third-party plugins build against); `scenario`
 * combinations stack scenario plugins on a base to demonstrate an effect. */
export type RecipeKind = 'base' | 'scenario'

/** One combination (recipe) as the feed's recipe catalog annotates it for
 * the local home: which packages it would still install, which it can not
 * satisfy at all, and whether its preset file already landed. */
export interface RemoteRecipeInfo {
  /** The recipe's stable id — also the preset file name's key. */
  id: string
  /** The recipe document's version (bumped when its rows change). */
  version: string
  /** Human title (`标准基座`, `产线看板`, …). */
  title: string
  /** One-line description of the combination's effect. */
  description?: string | undefined
  kind: RecipeKind
  /** The package names the recipe's rows address, deduplicated, document order. */
  plugins: readonly string[]
  /** Referenced packages not installed in the local pool — installing the
   * recipe downloads these from the feed first. */
  pending: readonly string[]
  /** Referenced packages that are neither installed nor in the feed's
   * plugin catalog — the recipe cannot land until the feed carries them. */
  unavailable: readonly string[]
  /** Whether the recipe's preset file already sits in the home's presets. */
  applied: boolean
}

/**
 * The `recipes.json` catalog a plugin feed serves beside `index.json`:
 * same non-strict discipline, same file-name safety rule — a recipe
 * document is fetched by pure file name under the configured base and
 * nothing else.
 */
export const remoteRecipesSchema = z.object({
  recipes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['base', 'scenario']),
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/),
  })),
})

/** One validated feed recipe catalog. */
export type RemoteRecipes = z.output<typeof remoteRecipesSchema>

/** Row names a recipe may address: package names and their subpath entries. */
const recipeNamePattern = /^(@[a-z0-9-]+\/[a-z0-9-]+|[a-z0-9-]+)(\/[a-z0-9-]+)*$/

/** Strict validation of a fetched recipe document: a recipe becomes a preset
 * file in the home, so anything beyond the user-layer row shape is refused. */
export const recipePayloadSchema = z.object({
  plugins: z.array(z.object({
    name: z.string().regex(recipeNamePattern),
    enabled: z.boolean().optional(),
    config: z.unknown().optional(),
  }).strict()).min(1),
}).strict()

/** One row of a recipe document — the exact user-layer row shape. */
export type RecipeRow = z.output<typeof recipePayloadSchema>['plugins'][number]

/** The recipe document payload: byte-for-byte the `plugins.yml` shape, so a
 * downloaded recipe lands as a preset file the compositor already speaks. */
export type RecipePayload = z.output<typeof recipePayloadSchema>

/** The `settings.json` key holding the plugin market feed's base URL. */
export const PLUGINS_FEED_URL_KEY = 'plugins.feedUrl'

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
