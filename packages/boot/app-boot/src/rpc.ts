/**
 * The layer administration's gateway bridge: exposes the merged plugin view
 * and the user-layer write operations as wire methods. Every mutation goes
 * through `ctx.pluginLayers`, lands in `plugins.yml`, and hot-applies — the
 * file stays the single interface for UI, Agent, and hand edits alike.
 *
 * @module @snap-rail/app-boot/rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { PluginInfo, PluginSource } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import { loadBuiltinLayer, loadUserLayer } from './compose.ts'
import { scanPluginPool } from './scan.ts'

/** The plugin-admin bridge plugin; mount after gateway, audit, and boot. */
const pluginAdminRpcPlugin: Plugin.Object<void> = {
  name: 'plugins-rpc',
  inject: ['gateway', 'audit', 'pluginLayers'],
  apply(ctx: Context): void {
    const gateway: GatewayService = ctx.gateway
    const audit: AuditService = ctx.audit
    const layers = ctx.pluginLayers

    gateway.registerMethod('plugins.list', () => {
      const builtin = loadBuiltinLayer(layers.handles.builtinLayerPath)
      const user = loadUserLayer(layers.handles.userLayerPath)
      const pool = scanPluginPool(layers.handles.poolDirs)
      const composed = new Map(layers.recompose().map(entry => [entry.id as string, entry]))

      const infos: PluginInfo[] = []
      const seen = new Set<string>()
      for (const entry of builtin) {
        seen.add(entry.name as string)
        const live = composed.get(entry.id as string)
        infos.push(toInfo(entry.name as string, 'builtin', live?.disabled !== true, live?.config))
      }
      for (const row of user.plugins) {
        if (seen.has(row.name)) continue
        if (!pool.has(row.name)) continue
        seen.add(row.name)
        const live = composed.get(row.name)
        infos.push(toInfo(row.name, 'user', live?.disabled !== true, live?.config))
      }
      for (const name of pool.keys()) {
        if (seen.has(name)) continue
        infos.push(toInfo(name, 'pool', false, undefined))
      }
      return { plugins: infos }
    })

    gateway.registerMethod('plugins.setEnabled', async ({ name, enabled }) => {
      await mutate(() => layers.setUserRow(name, { enabled }))
      audit.record({
        actor: 'client',
        action: enabled ? 'plugin.enable' : 'plugin.disable',
        subject: name,
      })
      return { applied: true } as const
    })

    gateway.registerMethod('plugins.setConfig', async ({ name, config }) => {
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
  return { name, source, enabled, ...config !== undefined ? { config } : {} }
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
