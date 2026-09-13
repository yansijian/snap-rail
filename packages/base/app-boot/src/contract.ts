/**
 * The plugins domain's wire contract: layer administration over the
 * two-layer composition. This module is the merge point — programs importing
 * it (the bridge, the settings page, tests) see the rows in the protocol's
 * open `RpcMethodMap`; everyone else stays untyped.
 *
 * @module @snap-rail/app-boot/contract
 */

import { z } from 'zod'
import { defineContract, method } from '@snap-rail/protocol'
import type { MethodRows } from '@snap-rail/protocol'

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

/** What a zip inspection reports: the install-time confirmation surface. */
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
    /** Install a plugin zip into the pool (validate → extract → compose). */
    'plugins.install': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ installed: { name: string, version: string } }>(),
    /** Peek at a zip's identity/category/permissions/dependencies without
     * installing; `missing` lists unsatisfied package requirements. */
    'plugins.inspect': method(z.object({ zipPath: z.string().min(1) }).strict())
      .ret<{ plugin: InspectedPlugin }>(),
    /** Remove a pool package, its rows, and its namespaced data. */
    'plugins.uninstall': method(z.object({ name: z.string().min(1) }).strict())
      .ret<{ removed: true }>(),
  },
  frames: {},
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof pluginsContract> {}
}
