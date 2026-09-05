/**
 * The plugins and update domains' wire contracts. This module is the merge
 * point — programs importing it (the bridges, the settings pages, tests)
 * see the rows in the protocol's open `RpcMethodMap`/`FrameMap`; everyone
 * else stays untyped.
 *
 * @module @snap-rail/app-boot/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'

/** Where a plugin row comes from in the merged view. */
export type PluginSource = 'builtin' | 'user' | 'pool'

/** One plugin as the management surface sees it. */
export interface PluginInfo {
  /** Package name (or subpath entry) — also the entry id in the composed list. */
  name: string
  /** Origin: shipped layer, user-layer insert, or available-in-pool only. */
  source: PluginSource
  /** Whether it is currently mounted (`false` covers disabled and unreferenced pool plugins). */
  enabled: boolean
  /** The npm package the row belongs to (`@scope/pkg` of `@scope/pkg/sub`) —
   * rows of one package render as one group under one master toggle. */
  packageName: string
  /** The package's declared kind (`snapRail.kind`): `suite` rows are mutually
   * exclusive — enabling one disables the others (terminals serve one
   * scenario at a time). */
  kind?: string
  /** The pool package's declared version (pool-sourced rows only). */
  version?: string
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

/** Plugin administration over the two-layer composition. */
export interface PluginsApi {
  /** Merged view: mounted entries with status plus pool plugins not referenced. */
  list(payload: {}): Promise<RpcResponse<{ plugins: readonly PluginInfo[] }>>
  /** Enable or disable one plugin by writing a user-layer row and hot-applying. */
  setEnabled(payload: { name: string, enabled: boolean }): Promise<RpcResponse<{ applied: true }>>
  /** Replace one plugin's config through a user-layer row and hot-apply. */
  setConfig(payload: { name: string, config: unknown }): Promise<RpcResponse<{ applied: true }>>
  /** Install a plugin zip into the pool (validate → extract → compose);
   * over an installed package, only a strictly higher version updates. */
  install(payload: { zipPath: string }): Promise<RpcResponse<{ installed: { name: string, version: string, updated: boolean } }>>
  /** Peek at a zip's identity/kind/permissions and how it would land
   * (`action`) against the installed version — no extraction, no pool writes. */
  inspect(payload: { zipPath: string }): Promise<RpcResponse<{ plugin: {
    name: string
    version: string
    kind?: string | undefined
    permissions: readonly string[]
    hasClient: boolean
    /** The installed version when the package is already in the pool. */
    installed?: { version: string } | undefined
    action: InstallAction
  } }>>
  /** Remove a pool package, its rows, and its namespaced data. */
  uninstall(payload: { name: string }): Promise<RpcResponse<{ removed: true }>>
  /** Fetch the configured plugin feed's catalog and annotate every entry
   * with how installing it would land against the local pool. */
  remoteList(payload: {}): Promise<RpcResponse<{ plugins: readonly RemotePluginInfo[], feedUrl: string }>>
  /** Download one catalog entry's zip from the feed and install it (the
   * same strictly-higher update rule as a local install). */
  remoteInstall(payload: { name: string }): Promise<RpcResponse<{ installed: { name: string, version: string, updated: boolean } }>>
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'plugins.list': PluginsApi['list']
    'plugins.set-enabled': PluginsApi['setEnabled']
    'plugins.set-config': PluginsApi['setConfig']
    'plugins.install': PluginsApi['install']
    'plugins.inspect': PluginsApi['inspect']
    'plugins.uninstall': PluginsApi['uninstall']
    'plugins.remote-list': PluginsApi['remoteList']
    'plugins.remote-install': PluginsApi['remoteInstall']
    'update.state': UpdateApi['state']
    'update.check': UpdateApi['check']
    'update.download': UpdateApi['download']
    'update.install': UpdateApi['install']
  }

  interface FrameMap {
    'update/status': UpdateStatus
  }
}

/** Request schemas for the plugins domain's methods (ride with registration). */
export const pluginsRequestSchemas = {
  'plugins.list': z.object({}).strict(),
  'plugins.set-enabled': z.object({
    name: z.string().min(1),
    enabled: z.boolean(),
  }).strict(),
  'plugins.set-config': z.object({
    name: z.string().min(1),
    config: z.unknown(),
  }).strict(),
  'plugins.install': z.object({
    zipPath: z.string().min(1),
  }).strict(),
  'plugins.inspect': z.object({
    zipPath: z.string().min(1),
  }).strict(),
  'plugins.uninstall': z.object({
    name: z.string().min(1),
  }).strict(),
  'plugins.remote-list': z.object({}).strict(),
  'plugins.remote-install': z.object({
    name: z.string().min(1),
  }).strict(),
} as const

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

/** The app-update surface: check, watch the automatic download, and install
 * (restart) once staged. Backed by electron-updater in the desktop shell. */
export interface UpdateApi {
  /** The current snapshot (the page's mount read; live updates ride `update/status`). */
  state(payload: {}): Promise<RpcResponse<{ status: UpdateStatus }>>
  /** Check the configured source now; the snapshot afterwards rides the frames. */
  check(payload: {}): Promise<RpcResponse<{ status: UpdateStatus }>>
  /** Download a found update (also runs automatically after a check). */
  download(payload: {}): Promise<RpcResponse<{ status: UpdateStatus }>>
  /** Quit and install a staged update. */
  install(payload: {}): Promise<RpcResponse<{ applied: true }>>
}

/** Request schemas for the update domain's methods (ride with registration). */
export const updateRequestSchemas = {
  'update.state': z.object({}).strict(),
  'update.check': z.object({}).strict(),
  'update.download': z.object({}).strict(),
  'update.install': z.object({}).strict(),
} as const

/** The `settings.json` key overriding the packaged update source (a generic-provider URL). */
export const UPDATE_FEED_URL_KEY = 'update.feedUrl'
/** The `settings.json` key gating the startup auto-check (boolean, default on). */
export const UPDATE_AUTO_CHECK_KEY = 'update.autoCheck'

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
})
