/**
 * The plugins domain's wire contract: layer administration over the
 * two-layer composition. This module is the merge point — programs importing
 * it (the bridge, the settings page, tests) see the rows in the protocol's
 * open `RpcMethodMap`; everyone else stays untyped.
 *
 * @module @snap-rail/app-boot/contract
 */

import { z } from 'zod'
import type { RpcResponse } from '@snap-rail/protocol'

/** Where a plugin row comes from in the merged view. */
export type PluginSource = 'builtin' | 'user' | 'pool'

/** One plugin as the management surface sees it. */
export interface PluginInfo {
  /** Package name; also the entry id in the composed list. */
  name: string
  /** Origin: shipped layer, user-layer insert, or available-in-pool only. */
  source: PluginSource
  /** Whether it is currently mounted (`false` covers disabled and unreferenced pool plugins). */
  enabled: boolean
  /** The entry's current config when one is set. */
  config?: unknown
}

/** Plugin administration over the two-layer composition. */
export interface PluginsApi {
  /** Merged view: mounted entries with status plus pool plugins not referenced. */
  list(payload: {}): Promise<RpcResponse<{ plugins: readonly PluginInfo[] }>>
  /** Enable or disable one plugin by writing a user-layer row and hot-applying. */
  setEnabled(payload: { name: string, enabled: boolean }): Promise<RpcResponse<{ applied: true }>>
  /** Replace one plugin's config through a user-layer row and hot-apply. */
  setConfig(payload: { name: string, config: unknown }): Promise<RpcResponse<{ applied: true }>>
}

declare module '@snap-rail/protocol' {
  interface RpcMethodMap {
    'plugins.list': PluginsApi['list']
    'plugins.set-enabled': PluginsApi['setEnabled']
    'plugins.set-config': PluginsApi['setConfig']
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
} as const
