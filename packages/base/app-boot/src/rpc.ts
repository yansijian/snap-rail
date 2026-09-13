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
import { pluginsContract, type PluginInfo, type PluginSource } from './contract.ts'
import { loadBuiltinLayer, loadPresetLayers, loadUserLayer, mergeLayers, packageNameOf } from './compose.ts'
import { createLayerView } from './layer-view.ts'
import { scanPluginPool } from './scan.ts'
import type { PluginDescriptor } from './scan.ts'
import { InstallError, installPluginFromZip, inspectPluginZip, uninstallPlugin } from './installer.ts'

/** The plugin-admin bridge plugin; mount after rpc, audit, and boot. */
const pluginAdminRpcPlugin: Plugin.Object<void> = {
  name: 'plugins-rpc',
  inject: ['rpc', 'audit', 'pluginLayers'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const audit: AuditService = ctx.audit
    const layers = ctx.pluginLayers
    // One derived view of the layer files: the protected set, manifests,
    // enabled packages, mutex groups, and requirement relations — shared
    // with the invariant sidecar.
    const view = createLayerView(layers.handles, service => ctx.get(service) !== undefined)

    rpc.claimDomain(ctx, 'plugins')

    const assertNotBase = (name: string): void => {
      const target = packageNameOf(name)
      const shipped = view.shippedNames()
      if (shipped.has(target) || shipped.has(name)) {
        throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`内置插件禁止删除/修改：${target}（替换经源码重建）`] } })
      }
    }

    /**
     * Forward check before an enable lands: every declared requirement must
     * be satisfiable now — a package requirement by an enabled package, a
     * `service:` requirement by a live service.
     */
    const assertRequirementsMet = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): void => {
      const missing = view.missingRequirements(name, pool)
      if (missing.length > 0) {
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: [`缺少依赖：${missing.join('、')}（请先安装并启用它们）`] },
        })
      }
    }

    rpc.serveContract(ctx, pluginsContract, {
      'plugins.list': () => {
        const builtin = loadBuiltinLayer(layers.handles.builtinLayerPath)
        const user = loadUserLayer(layers.handles.userLayerPath)
        const presetLayers = loadPresetLayers(layers.handles.presetDirs)
        const pool = scanPluginPool(layers.handles.poolDirs)
        const composed = new Map(layers.recompose().map(entry => [entry.id as string, entry]))
        // Renderer occupants ship with the app (never pool-resident); a user
        // row can disable or re-config one, and absent rows mean enabled.
        const userRows = new Map(user.plugins.map(row => [row.name, row]))
        // The merged view (presets beneath the user layer) is what the
        // composition actually mounts; names only a preset carries surface
        // with the 'preset' origin so the management page can show them.
        const mergedRows = new Map(mergeLayers([...presetLayers, user]).plugins.map(row => [row.name, row]))
        const presetOnly = new Set<string>([...mergedRows.keys()].filter(name => !userRows.has(name)))

        const infos: PluginInfo[] = []
        const seen = new Set<string>()
        const toInfoFor = (name: string, source: PluginSource, enabled: boolean, config: unknown): PluginInfo => {
          const { kind, layer, title, category, exclusive, framework, clientOnly, requires } = view.manifestOf(name, pool)
          return {
            name,
            source,
            enabled,
            packageName: packageNameOf(name),
            ...(kind !== undefined ? { kind } : {}),
            ...(layer !== undefined ? { layer } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(exclusive !== undefined ? { exclusive } : {}),
            ...(framework !== undefined ? { framework } : {}),
            ...(clientOnly ? { clientOnly: true } : {}),
            ...(requires !== undefined && requires.length > 0 ? { requires } : {}),
            ...config !== undefined ? { config } : {},
          }
        }
        for (const entry of builtin) {
          seen.add(entry.name as string)
          const live = composed.get(entry.id as string)
          infos.push(toInfoFor(entry.name as string, 'builtin', live?.disabled !== true, live?.config))
        }
        for (const row of user.plugins) {
          if (seen.has(row.name)) continue
          const inPool = pool.has(row.name) || pool.has(packageNameOf(row.name))
          if (!inPool && !layers.handles.rendererPackages.includes(row.name)) continue
          seen.add(row.name)
          const live = composed.get(row.name)
          // Pool-resident packages report their physical origin ('pool') and
          // their real mounted state: a disabled pool entry is omitted from the
          // composition entirely, so presence in it is the truth. Renderer rows
          // are config-only (never composed) and keep the row's flag.
          const enabled = inPool ? composed.has(row.name) : row.enabled !== false
          infos.push(toInfoFor(row.name, inPool ? 'pool' : 'user', enabled, live?.config ?? row.config))
        }
        // Installed but never referenced: pool plugins mount only through an
        // explicit row, so a rowless package lists as off — unless a preset
        // row carries it (then the preset's flag and origin show).
        for (const name of pool.keys()) {
          if (seen.has(name)) continue
          const presetRow = mergedRows.get(name)
          if (presetRow !== undefined && presetOnly.has(name)) {
            infos.push(toInfoFor(name, 'preset', composed.has(name), presetRow.config))
            continue
          }
          infos.push(toInfoFor(name, 'pool', false, undefined))
        }
        // Renderer rows are config-only in the host tree but still the user's
        // plugins — list them (their enable toggle applies after a restart);
        // a preset-only renderer row shows its preset origin too.
        for (const name of layers.handles.rendererPackages) {
          if (seen.has(name)) continue
          const row = mergedRows.get(name)
          infos.push(toInfoFor(name, presetOnly.has(name) ? 'preset' : 'builtin', row === undefined || row.enabled !== false, row?.config))
        }
        return { plugins: infos }
      },

      'plugins.set-enabled': async ({ name, enabled }) => {
        assertNotBase(name)
        const pool = scanPluginPool(layers.handles.poolDirs)
        if (enabled) {
          // Every requirement must be satisfiable before the row lands — an
          // enable that cannot activate would fail the next boot instead.
          assertRequirementsMet(name, pool)
        } else {
          const dependents = view.dependentsOf(name, pool)
          if (dependents.length > 0) {
            throw new RpcBusinessError({
              code: 'bad-request',
              details: { issues: [`还有已启用的插件依赖 ${packageNameOf(name)}：${dependents.join('、')}（先禁用它们）`] },
            })
          }
        }
        // Mutex groups: activating a package deactivates every other enabled
        // member of its exclusive group in the same batched write. Groups come
        // from `snapRail.exclusive` (framework, store-backend, …); `suite` rows
        // default to the 'suite' group (one industrial terminal serves one
        // scenario at a time).
        const edits: Array<{ name: string, enabled: boolean }> = [{ name, enabled }]
        if (enabled) {
          const builtin = loadBuiltinLayer(layers.handles.builtinLayerPath)
          const user = loadUserLayer(layers.handles.userLayerPath)
          const everyName = new Set<string>([
            ...builtin.map(entry => entry.name as string),
            ...user.plugins.map(row => row.name),
            ...layers.handles.rendererPackages,
            ...pool.keys(),
          ])
          const groupOf = (candidate: string): string | undefined => view.groupOf(candidate, pool)
          const group = groupOf(packageNameOf(name))
          if (group !== undefined) {
            const target = packageNameOf(name)
            for (const candidate of everyName) {
              const owner = packageNameOf(candidate)
              if (owner !== target && groupOf(candidate) === group) edits.push({ name: candidate, enabled: false })
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
      },

      'plugins.set-config': async ({ name, config }) => {
        assertNotBase(name)
        await mutate(() => layers.setUserRow(name, { config }))
        audit.record({
          actor: 'client',
          action: 'plugin.config',
          subject: name,
          detail: { config },
        })
        return { applied: true } as const
      },

      'plugins.install': async ({ zipPath }) => {
        const poolDir = layers.handles.poolDirs[0]
        if (poolDir === undefined) {
          throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
        }
        let installed: { name: string, version: string }
        try {
          installed = installPluginFromZip(zipPath, poolDir, { reserved: [...view.shippedNames()] })
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
      },

      'plugins.inspect': ({ zipPath }) => {
        try {
          const plugin = inspectPluginZip(zipPath)
          // Package requirements the home cannot satisfy yet surface as install
          // warnings: not installed (neither pool nor app tree). Service
          // requirements are runtime facts, not install-time ones.
          const pool = scanPluginPool(layers.handles.poolDirs)
          const missing = plugin.requires
            .filter(entry => !entry.startsWith('service:'))
            .filter(entry => !pool.has(entry))
          return { plugin: { ...plugin, missing } }
        } catch (cause) {
          throw new RpcBusinessError({
            code: 'bad-request',
            details: { issues: [cause instanceof Error ? cause.message : String(cause)] },
          })
        }
      },

      'plugins.uninstall': async ({ name }) => {
        assertNotBase(name)
        const poolDir = layers.handles.poolDirs[0]
        if (poolDir === undefined) {
          throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
        }
        const pool = scanPluginPool(layers.handles.poolDirs)
        const dependents = view.dependentsOf(name, pool)
        if (dependents.length > 0) {
          throw new RpcBusinessError({
            code: 'bad-request',
            details: { issues: [`还有已启用的插件依赖 ${packageNameOf(name)}：${dependents.join('、')}（先卸载/禁用它们）`] },
          })
        }
        // A preset row referencing the package would break every future
        // composition the moment the directory disappears — the preset is
        // the owner of that row; adjust or replace the preset first.
        const presetHolder = loadPresetLayers(layers.handles.presetDirs)
          .flatMap(layer => layer.plugins)
          .find(row => row.name === name || packageNameOf(row.name) === name)
        if (presetHolder !== undefined) {
          throw new RpcBusinessError({
            code: 'conflict',
            details: { what: `预设引用了 ${name}：请先调整预设再卸载` },
          })
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
      },
    })
  },
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
