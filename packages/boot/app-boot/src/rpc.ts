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
import { dirname } from 'node:path'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import { pluginsRequestSchemas, type PluginInfo, type PluginSource } from './contract.ts'
import { loadBuiltinLayer, loadUserLayer, packageKindOf, packageNameOf } from './compose.ts'
import { scanPluginPool } from './scan.ts'
import { InstallError, installPluginFromZip, inspectPluginZip, uninstallPlugin } from './installer.ts'

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
      const kindOf = (name: string): string | undefined =>
        packageKindOf(name, layers.handles.appRoot, pool)
      const composed = new Map(layers.recompose().map(entry => [entry.id as string, entry]))
      // Renderer occupants ship with the app (never pool-resident); a user
      // row can disable or re-config one, and absent rows mean enabled.
      const userRows = new Map(user.plugins.map(row => [row.name, row]))

      const infos: PluginInfo[] = []
      const seen = new Set<string>()
      for (const entry of builtin) {
        seen.add(entry.name as string)
        const live = composed.get(entry.id as string)
        infos.push(toInfo(entry.name as string, 'builtin', live?.disabled !== true, live?.config, kindOf(entry.name as string)))
      }
      for (const row of user.plugins) {
        if (seen.has(row.name)) continue
        const inPool = pool.has(row.name)
        if (!inPool && !layers.handles.rendererPackages.includes(row.name)) continue
        seen.add(row.name)
        const live = composed.get(row.name)
        // Pool-resident packages report their physical origin ('pool') and
        // their real mounted state: a disabled pool entry is omitted from the
        // composition entirely, so presence in it is the truth. Renderer rows
        // are config-only (never composed) and keep the row's flag.
        const enabled = inPool ? composed.has(row.name) : row.enabled !== false
        infos.push(toInfo(row.name, inPool ? 'pool' : 'user', enabled, live?.config ?? row.config, kindOf(row.name)))
      }
      // Installed but never enabled: pool plugins mount only through an
      // explicit user row, so a rowless package lists as off.
      for (const name of pool.keys()) {
        if (seen.has(name)) continue
        infos.push(toInfo(name, 'pool', false, undefined, kindOf(name)))
      }
      // Renderer rows are config-only in the host tree but still the user's
      // plugins — list them (their enable toggle applies after a restart).
      for (const name of layers.handles.rendererPackages) {
        if (seen.has(name)) continue
        const row = userRows.get(name)
        infos.push(toInfo(name, 'builtin', row === undefined || row.enabled !== false, row?.config, kindOf(name)))
      }
      return { plugins: infos }
    })

    rpc.method(ctx, 'plugins.set-enabled', { request: pluginsRequestSchemas['plugins.set-enabled'] }, async ({ name, enabled }) => {
      // Suite exclusivity: activating a suite deactivates every other suite
      // package's rows in the same batched write (one industrial terminal
      // serves one scenario at a time).
      const edits: Array<{ name: string, enabled: boolean }> = [{ name, enabled }]
      if (enabled) {
        const pool = scanPluginPool(layers.handles.poolDirs)
        const kindOf = (candidate: string): string | undefined =>
          packageKindOf(candidate, layers.handles.appRoot, pool)
        const builtin = loadBuiltinLayer(layers.handles.builtinLayerPath)
        const user = loadUserLayer(layers.handles.userLayerPath)
        const everyName = new Set<string>([
          ...builtin.map(entry => entry.name as string),
          ...user.plugins.map(row => row.name),
          ...layers.handles.rendererPackages,
          ...pool.keys(),
        ])
        const suites = new Set(
          [...everyName].filter(candidate => kindOf(candidate) === 'suite').map(name => packageNameOf(name)),
        )
        const target = packageNameOf(name)
        if (suites.has(target)) {
          for (const candidate of everyName) {
            const owner = packageNameOf(candidate)
            if (owner !== target && suites.has(owner)) edits.push({ name: candidate, enabled: false })
          }
        }
      }
      await mutate(() => layers.setUserRows(edits))
      audit.record({
        actor: 'client',
        action: enabled ? 'plugin.enable' : 'plugin.disable',
        subject: name,
        ...(edits.length > 1 ? { detail: { deactivated: edits.slice(1).map(edit => edit.name) } } : {}),
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

    rpc.method(ctx, 'plugins.install', { request: pluginsRequestSchemas['plugins.install'] }, async ({ zipPath }) => {
      const poolDir = layers.handles.poolDirs[0]
      if (poolDir === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
      }
      let installed: { name: string, version: string }
      try {
        installed = installPluginFromZip(zipPath, poolDir)
      } catch (cause) {
        if (cause instanceof InstallError && cause.kind === 'conflict') {
          throw new RpcBusinessError({ code: 'conflict', details: { what: cause.message } })
        }
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: [cause instanceof Error ? cause.message : String(cause)] },
        })
      }
      // The pool watch may race the explicit apply; both paths converge on
      // the same composition, and the pool scan now sees the package.
      await mutate(async () => {
        await layers.apply()
      })
      audit.record({
        actor: 'client',
        action: 'plugin.install',
        subject: installed.name,
        detail: { version: installed.version },
      })
      return { installed }
    })

    rpc.method(ctx, 'plugins.inspect', { request: pluginsRequestSchemas['plugins.inspect'] }, ({ zipPath }) => {
      try {
        return { plugin: inspectPluginZip(zipPath) }
      } catch (cause) {
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: [cause instanceof Error ? cause.message : String(cause)] },
        })
      }
    })

    rpc.method(ctx, 'plugins.uninstall', { request: pluginsRequestSchemas['plugins.uninstall'] }, async ({ name }) => {
      const poolDir = layers.handles.poolDirs[0]
      if (poolDir === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
      }
      // The row goes first (the package unmounts), then the files, then one
      // converging apply — the file must never keep a row naming a package
      // that is gone, or the next boot fails to compose.
      await mutate(async () => {
        await layers.removeUserRow(name)
        uninstallPlugin(name, poolDir, dirname(layers.handles.userLayerPath))
        await layers.apply()
      })
      audit.record({ actor: 'client', action: 'plugin.uninstall', subject: name })
      return { removed: true } as const
    })
  },
}

function toInfo(
  name: string,
  source: PluginSource,
  enabled: boolean,
  config: unknown,
  kind?: string,
): PluginInfo {
  return {
    name,
    source,
    enabled,
    packageName: packageNameOf(name),
    ...(kind !== undefined ? { kind } : {}),
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
