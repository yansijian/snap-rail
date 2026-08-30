/**
 * The layer administration's rpc bridge: exposes the merged plugin view
 * and the user-layer write operations as wire methods. Every mutation goes
 * through `ctx.pluginLayers`, lands in `plugins.yml`, and hot-applies — the
 * file stays the single interface for UI, Agent, and hand edits alike.
 * Claims the `plugins` domain; signatures and schemas live in `./contract`.
 *
 * @module @snap-rail/app-boot/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import { pluginsRequestSchemas, type PluginInfo, type PluginSource } from './contract.ts'
import { loadBuiltinLayer, loadUserLayer, packageNameOf } from './compose.ts'
import { scanPluginPool } from './scan.ts'

/** The plugin-admin bridge plugin; mount after rpc, audit, and boot. */
const pluginAdminRpcPlugin: Plugin.Object<void> = {
  name: 'plugins-rpc',
  inject: ['rpc', 'audit', 'pluginLayers'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const audit: AuditService = ctx.audit
    const layers = ctx.pluginLayers

    rpc.claimDomain(ctx, 'plugins')

    rpc.method(ctx, 'plugins.list', { request: pluginsRequestSchemas['plugins.list'] }, () => {
      const builtin = loadBuiltinLayer(layers.handles.builtinLayerPath)
      const user = loadUserLayer(layers.handles.userLayerPath)
      const pool = scanPluginPool(layers.handles.poolDirs)
      const composed = new Map(layers.recompose().map(entry => [entry.id as string, entry]))
      // Renderer occupants ship with the app (never pool-resident); a user
      // row can disable or re-config one, and absent rows mean enabled.
      const userRows = new Map(user.plugins.map(row => [row.name, row]))

      const infos: PluginInfo[] = []
      const seen = new Set<string>()
      for (const entry of builtin) {
        seen.add(entry.name as string)
        const live = composed.get(entry.id as string)
        infos.push(toInfo(entry.name as string, 'builtin', live?.disabled !== true, live?.config))
      }
      for (const row of user.plugins) {
        if (seen.has(row.name)) continue
        if (!pool.has(row.name) && !layers.handles.rendererPackages.includes(row.name)) continue
        seen.add(row.name)
        const live = composed.get(row.name)
        infos.push(toInfo(row.name, 'user', live?.disabled !== true, live?.config))
      }
      for (const name of pool.keys()) {
        if (seen.has(name)) continue
        infos.push(toInfo(name, 'pool', false, undefined))
      }
      // Renderer rows are config-only in the host tree but still the user's
      // plugins — list them (their enable toggle applies after a restart).
      for (const name of layers.handles.rendererPackages) {
        if (seen.has(name)) continue
        const row = userRows.get(name)
        infos.push(toInfo(name, 'builtin', row === undefined || row.enabled !== false, row?.config))
      }
      return { plugins: infos }
    })

    rpc.method(ctx, 'plugins.set-enabled', { request: pluginsRequestSchemas['plugins.set-enabled'] }, async ({ name, enabled }) => {
      await mutate(() => layers.setUserRow(name, { enabled }))
      audit.record({
        actor: 'client',
        action: enabled ? 'plugin.enable' : 'plugin.disable',
        subject: name,
      })
      return { applied: true } as const
    })

    rpc.method(ctx, 'plugins.set-config', { request: pluginsRequestSchemas['plugins.set-config'] }, async ({ name, config }) => {
      await mutate(() => layers.setUserRow(name, { config }))
      audit.record({
        actor: 'client',
        action: 'plugin.config',
        subject: name,
        detail: { config },
      })
      return { applied: true } as const
    })
  },
}

function toInfo(name: string, source: PluginSource, enabled: boolean, config: unknown): PluginInfo {
  return {
    name,
    source,
    enabled,
    packageName: packageNameOf(name),
    ...config !== undefined ? { config } : {},
  }
}

async function mutate(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (cause) {
    // Composition/refresh failures keep the old tree; surface as a business
    // failure so the caller sees why nothing changed.
    throw new RpcBusinessError({
      code: 'bad-request',
      details: { issues: [cause instanceof Error ? cause.message : String(cause)] },
    })
  }
}

export default pluginAdminRpcPlugin
