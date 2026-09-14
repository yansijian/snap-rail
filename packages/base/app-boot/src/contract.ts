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
  /** The zip's file name relative to the feed — never a URL. The host
   * resolves it against the configured feed and nothing else, so the wire
   * never carries a client-chosen download location. */
  file: string
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
  /** Package requirements the home cannot satisfy (not installed) — the
   * confirmation dialog shows these as warnings. */
  missing: readonly string[]
  /** The installed version when the package is already in the pool. */
  installed?: { version: string } | undefined
  /** How the install would land over that version. */
  action: InstallAction
}

/** One wire method of the plugins domain, from its declaration to its
 * handler: the merged `RpcMethodMap` rows, the trust-boundary request
 * schemas, and the handler table all derive from this one declaration. */
export const pluginsContract = defineContract('plugins', {
  methods: {
    /** Merged view: mounted entries with status plus pool plugins not referenced. */
    'plugins.list': method(z.object({}).strict()).ret<{ plugins: readonly PluginInfo[] }>(),
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
  },
  frames: {},
})

/** The legal package-name shape the installer enforces (shared with the catalog). */
const packageNamePattern = /^@[a-z0-9-]+\/[a-z0-9-]+$|^[a-z0-9-]+$/

/**
 * The `index.json` catalog a plugin feed serves: the packer emits it, the
 * host validates it before anything downstream sees an entry. Deliberately
 * non-strict — unknown fields strip so older hosts keep reading newer
 * catalogs — with the load-bearing fields enforced (the file name pattern
 * keeps downloads under the feed base, no traversal, no absolute URLs).
 */
export const remoteCatalogSchema = z.object({
  plugins: z.array(z.object({
    name: z.string().regex(packageNamePattern),
    version: z.string().min(1),
    description: z.string().optional(),
    kind: z.string().optional(),
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/),
  })),
})

/** One validated feed catalog. */
export type RemoteCatalog = z.output<typeof remoteCatalogSchema>

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
