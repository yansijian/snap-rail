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
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump } from 'js-yaml'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import { pluginsContract, type PluginInfo, type PluginSource } from './contract.ts'
import {
  appliedRecipeIds,
  loadBuiltinLayer,
  loadPresetLayers,
  loadUserLayer,
  mergeLayers,
  packageNameOf,
  recipePresetFileName,
} from './compose.ts'
import type { UserLayer } from './compose.ts'
import { atomicWrite } from './admin.ts'
import { createLayerView } from './layer-view.ts'
import { scanPluginPool } from './scan.ts'
import type { PluginDescriptor } from './scan.ts'
import {
  annotateCatalog,
  downloadRemotePluginZip,
  fetchRecipeDocument,
  fetchRemoteCatalog,
  fetchRemoteRecipes,
  MarketError,
  readPluginFeedUrl,
} from './market.ts'
import {
  compareVersions,
  HOST_ENGINE_VERSIONS,
  installedVersionOf,
  InstallError,
  installPluginFromZip,
  inspectPluginZip,
  uninstallPlugin,
  withPluginPoolTransaction,
} from './installer.ts'
import { loadTrustedReleaseKeys } from './trust.ts'

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
      const missingCapabilities = view.missingCapabilities(name, pool)
      if (missing.length > 0 || missingCapabilities.length > 0) {
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: [`缺少依赖：${[...missing, ...missingCapabilities].join('、')}（请先安装并启用它们）`] },
        })
      }
    }

    /** The configured market feed base URL, read straight from
     * `<home>/settings.json` (via `readPluginFeedUrl`): the plugins domain
     * must not couple to the settings service's lifecycle — it is the
     * uninstall path for the settings package itself. An unset key reads as
     * "no market feed configured". */
    const marketFeedUrl = (): string => {
      const value = readPluginFeedUrl(dirname(layers.handles.userLayerPath))
      if (value === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: '未配置插件源：请先在「插件市场」填写插件源地址' } })
      }
      return value
    }

    /** The first pool directory; every install path lands there. */
    const poolDirOf = (): string => {
      const poolDir = layers.handles.poolDirs[0]
      if (poolDir === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
      }
      return poolDir
    }

    const trustedKeys = (): readonly import('@snap-rail/plugin-kit/sign').TrustedReleaseKey[] =>
      loadTrustedReleaseKeys(dirname(layers.handles.userLayerPath))

    /** Map market fetch failures onto the wire's business codes. */
    const marketCall = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run()
      } catch (cause) {
        if (cause instanceof MarketError) {
          if (cause.kind === 'bad-catalog') {
            throw new RpcBusinessError({ code: 'bad-request', details: { issues: [cause.message] } })
          }
          throw new RpcBusinessError({
            code: cause.kind === 'not-found' ? 'not-found' : 'unavailable',
            details: { what: cause.message },
          })
        }
        throw cause
      }
    }

    /** The shared install pipeline: local zips and market downloads land
     * here — capture the previous version, install (strictly-higher rule,
     * built-in names refused), hot-apply, audit. Returns the wire shape. */
    const runInstall = async (zipPath: string, via?: string): Promise<{ installed: { name: string, version: string, updated: boolean } }> => {
      const poolDir = layers.handles.poolDirs[0]
      if (poolDir === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
      }
      // The installed version must be read before the swap replaces it; the
      // pre-read is best-effort (the install validates and reports its own
      // errors, and `updated` stays the authority).
      const previous = (() => {
        try {
          return installedVersionOf(poolDir, inspectPluginZip(zipPath, { trustedKeys: trustedKeys() }).name)
        } catch {
          return undefined
        }
      })()
      let installed: { name: string, version: string, updated: boolean }
      try {
        installed = installPluginFromZip(zipPath, poolDir, {
          reserved: [...view.shippedNames()],
          trustedKeys: trustedKeys(),
        })
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
        action: installed.updated ? 'plugin.update' : 'plugin.install',
        subject: installed.name,
        detail: {
          ...(installed.updated && previous !== undefined
            ? { from: previous, to: installed.version }
            : { version: installed.version }),
          ...(via !== undefined ? { via } : {}),
        },
      })
      // Project to the wire shape — the host-absolute staging dir stays host-side.
      return { installed: { name: installed.name, version: installed.version, updated: installed.updated } }
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
        const toInfoFor = (name: string, source: PluginSource, enabled: boolean, config: unknown, version?: string): PluginInfo => {
          const { kind, layer, title, category, exclusive, framework, clientOnly, requires, capabilities, engines } = view.manifestOf(name, pool)
          const signatureKeyId = pool.get(packageNameOf(name))?.signatureKeyId
          return {
            name,
            source,
            enabled,
            packageName: packageNameOf(name),
            ...(kind !== undefined ? { kind } : {}),
            ...(version !== undefined ? { version } : {}),
            ...(layer !== undefined ? { layer } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(exclusive !== undefined ? { exclusive } : {}),
            ...(framework !== undefined ? { framework } : {}),
            ...(clientOnly ? { clientOnly: true } : {}),
            ...(requires !== undefined && requires.length > 0 ? { requires } : {}),
            ...(capabilities === undefined ? {} : { capabilities }),
            ...(engines === undefined ? {} : { engines }),
            ...(signatureKeyId === undefined ? {} : { signatureKeyId }),
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
          const poolVersion = pool.get(row.name)?.version ?? pool.get(packageNameOf(row.name))?.version
          infos.push(toInfoFor(row.name, inPool ? 'pool' : 'user', enabled, live?.config ?? row.config, poolVersion))
        }
        // Installed but never referenced: pool plugins mount only through an
        // explicit row, so a rowless package lists as off — unless a preset
        // row carries it (then the preset's flag and origin show).
        for (const [name, entry] of pool) {
          if (seen.has(name)) continue
          const presetRow = mergedRows.get(name)
          if (presetRow !== undefined && presetOnly.has(name)) {
            infos.push(toInfoFor(name, 'preset', composed.has(name), presetRow.config, entry.version))
            continue
          }
          infos.push(toInfoFor(name, 'pool', false, undefined, entry.version))
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

      'plugins.diagnostics': () => {
        const pool = scanPluginPool(layers.handles.poolDirs)
        const enabled = [...view.enabledPackages(pool)].sort()
        const missing = enabled.map(name => ({
          name,
          requirements: view.missingRequirements(name, pool),
          capabilities: view.missingCapabilities(name, pool),
        })).filter(row => row.requirements.length > 0 || row.capabilities.length > 0)
        const signatures = [...pool.values()]
          .map(descriptor => descriptor.signatureKeyId === undefined
            ? undefined
            : { name: descriptor.name, keyId: descriptor.signatureKeyId })
          .filter((entry): entry is { name: string, keyId: string } => entry !== undefined)
          .sort((a, b) => a.name.localeCompare(b.name))
        return {
          snapshot: {
            host: { ...HOST_ENGINE_VERSIONS },
            enabled,
            missing,
            signatures,
            lastFailure: layers.lastFailure(),
          },
        }
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

      'plugins.install': ({ zipPath }) =>
        runInstall(zipPath),

      'plugins.inspect': ({ zipPath }) => {
        try {
          const plugin = inspectPluginZip(zipPath, { trustedKeys: trustedKeys() })
          // Package requirements the home cannot satisfy yet surface as install
          // warnings: not installed (neither pool nor app tree). Service
          // requirements are runtime facts, not install-time ones.
          const pool = scanPluginPool(layers.handles.poolDirs)
          const missingPackages = plugin.requires
            .filter(entry => !entry.startsWith('service:'))
            .filter(entry => !pool.has(entry))
          const providers = [...new Set([...pool.keys(), ...view.shippedNames()])]
            .flatMap(name => view.manifestOf(name, pool).capabilities?.provides ?? [])
          const missingCapabilities = (plugin.capabilities?.requires ?? [])
            .filter(requirement => requirement.optional !== true)
            .filter(requirement => !providers.some(provider => provider.id === requirement.id && satisfiesCapabilityRange(provider.version, requirement.range)))
            .map(requirement => `${requirement.id}@${requirement.range}`)
          const missing = [...missingPackages, ...missingCapabilities]
          // How the install would land over the installed version drives the
          // confirmation dialog's update/block branches.
          const poolDir = layers.handles.poolDirs[0]
          const installedVersion = poolDir === undefined ? undefined : installedVersionOf(poolDir, plugin.name)
          if (installedVersion === undefined) {
            return { plugin: { ...plugin, missing, action: 'install' as const } }
          }
          const action = compareVersions(plugin.version, installedVersion) > 0
            ? ('update' as const)
            : ('blocked' as const)
          return { plugin: { ...plugin, missing, action, installed: { version: installedVersion } } }
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

      'plugins.remote-list': async () => {
        const feedUrl = marketFeedUrl()
        const poolDir = poolDirOf()
        const catalog = await marketCall(() => fetchRemoteCatalog(feedUrl))
        return { plugins: annotateCatalog(catalog, poolDir), feedUrl }
      },

      'plugins.remote-install': async ({ name }) => {
        const feedUrl = marketFeedUrl()
        // The zip URL resolves only from the freshly fetched catalog — the
        // client names a plugin, never a download location.
        const catalog = await marketCall(() => fetchRemoteCatalog(feedUrl))
        const entry = catalog.plugins.find(candidate => candidate.name === name)
        if (entry === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `${name} 不在插件源目录中` } })
        }
        const zipPath = await marketCall(() => downloadRemotePluginZip(feedUrl, entry.file, entry.sha256))
        try {
          return await runInstall(zipPath, 'market')
        } finally {
          rmSync(zipPath, { force: true })
        }
      },

      'plugins.remote-recipes': async () => {
        const feedUrl = marketFeedUrl()
        const poolDir = poolDirOf()
        const [recipes, catalog] = await Promise.all([
          marketCall(() => fetchRemoteRecipes(feedUrl)),
          marketCall(() => fetchRemoteCatalog(feedUrl)),
        ])
        const pool = scanPluginPool([poolDir])
        const feedNames = new Set(catalog.plugins.map(entry => entry.name))
        const applied = appliedRecipeIds(layers.handles.presetDirs)
        const infos = await Promise.all(recipes.recipes.map(async recipe => {
          const payload = await marketCall(() => fetchRecipeDocument(feedUrl, recipe.file))
          const referenced = [...new Set(payload.plugins.map(row => packageNameOf(row.name)))]
          const pending = referenced.filter(name => !pool.has(name))
          return {
            id: recipe.id,
            version: recipe.version,
            title: recipe.title,
            ...(recipe.description !== undefined ? { description: recipe.description } : {}),
            kind: recipe.kind,
            plugins: referenced,
            pending,
            unavailable: pending.filter(name => !feedNames.has(name)),
            applied: applied.has(recipe.id),
          }
        }))
        return { recipes: infos, feedUrl }
      },

      'plugins.remote-install-recipe': async ({ id }) => {
        const feedUrl = marketFeedUrl()
        const poolDir = poolDirOf()
        // Everything resolves from freshly fetched feed documents — the
        // client names a recipe id, never a download location.
        const recipes = await marketCall(() => fetchRemoteRecipes(feedUrl))
        const recipe = recipes.recipes.find(candidate => candidate.id === id)
        if (recipe === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `组合 ${id} 不在组合目录中` } })
        }
        const payload = await marketCall(() => fetchRecipeDocument(feedUrl, recipe.file))
        const catalog = await marketCall(() => fetchRemoteCatalog(feedUrl))
        const feedByName = new Map(catalog.plugins.map(entry => [entry.name, entry]))
        // Unique referenced packages in document order; one lands only when
        // the pool lacks it or the feed upgrades it — a current pool package
        // is left exactly as the user has it.
        const targets: Array<{ name: string, file: string, sha256: string | undefined }> = []
        for (const row of payload.plugins) {
          const name = packageNameOf(row.name)
          if (targets.some(target => target.name === name)) continue
          const feedEntry = feedByName.get(name)
          const installedVersion = installedVersionOf(poolDir, name)
          if (feedEntry === undefined) {
            if (installedVersion === undefined) {
              throw new RpcBusinessError({
                code: 'bad-request',
                details: { issues: [`组合引用的 ${name} 既未安装也不在插件源目录中：请先更新插件源或调整组合`] },
              })
            }
            continue
          }
          if (installedVersion !== undefined && compareVersions(feedEntry.version, installedVersion) <= 0) continue
          targets.push({ name, file: feedEntry.file, sha256: feedEntry.sha256 })
        }
        const installed: Array<{ name: string, version: string, updated: boolean }> = []
        const presetDir = layers.handles.presetDirs[0]
        if (presetDir === undefined) {
          throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no preset directory is configured' } })
        }
        const presetPath = join(presetDir, recipePresetFileName(id))
        const previousPreset = existsSync(presetPath) ? readFileSync(presetPath, 'utf8') : undefined
        const rows = payload.plugins.map(row => ({
          name: row.name,
          ...(row.enabled !== undefined ? { enabled: row.enabled } : {}),
          ...(row.config !== undefined ? { config: row.config } : {}),
        }))
        try {
          await withPluginPoolTransaction(poolDir, targets.map(target => target.name), async () => {
            for (const target of targets) {
              const zipPath = await marketCall(() => downloadRemotePluginZip(feedUrl, target.file, target.sha256))
              try {
                const result = await runInstall(zipPath, 'recipe')
                installed.push(result.installed)
              } finally {
                rmSync(zipPath, { force: true })
              }
            }
            // The preset is part of the same recipe transaction: a failed
            // write or compose must restore both the pool and the previous
            // combination, otherwise the next boot sees a half-installed
            // recipe.
            mkdirSync(presetDir, { recursive: true })
            atomicWrite(presetPath, dump({ plugins: rows } satisfies UserLayer))
            await mutate(async () => {
              await layers.apply()
            })
          })
        } catch (cause) {
          // The filesystem transaction restored the prior pool. Restore the
          // prior preset too, then recompose the old tree before surfacing the
          // failed recipe operation.
          if (previousPreset === undefined) rmSync(presetPath, { force: true })
          else atomicWrite(presetPath, previousPreset)
          try { await layers.apply() } catch { /* preserve the original failure */ }
          throw cause
        }
        audit.record({
          actor: 'client',
          action: 'recipe.install',
          subject: id,
          detail: {
            version: recipe.version,
            ...(installed.length > 0 ? { installed: installed.map(entry => `${entry.name}@${entry.version}`) } : {}),
          },
        })
        return { installed, applied: true } as const
      },

      'plugins.remove-recipe': async ({ id }) => {
        const presetDir = layers.handles.presetDirs[0]
        if (presetDir === undefined) {
          throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no preset directory is configured' } })
        }
        const file = join(presetDir, recipePresetFileName(id))
        if (!existsSync(file)) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `组合 ${id} 尚未安装` } })
        }
        rmSync(file, { force: true })
        await mutate(async () => {
          await layers.apply()
        })
        audit.record({ actor: 'client', action: 'recipe.remove', subject: id })
        return { removed: true } as const
      },
    })
  },
}

function satisfiesCapabilityRange(version: string, range: string): boolean {
  const parse = (value: string): [number, number, number] => {
    const parts = value.replace(/^[^0-9]*/, '').split(/[.-]/).slice(0, 3).map(part => /^\d+$/.test(part) ? Number(part) : 0)
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  }
  const actual = parse(version)
  const trimmed = range.trim()
  const prefix = trimmed.startsWith('>=') ? '>=' : trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : ''
  const expected = parse(trimmed.slice(prefix.length))
  const compare = (): number => {
    for (let index = 0; index < 3; index += 1) if (actual[index] !== expected[index]) return actual[index]! < expected[index]! ? -1 : 1
    return 0
  }
  if (prefix === '>=') return compare() >= 0
  if (prefix === '^') return actual[0] === expected[0] && compare() >= 0
  if (prefix === '~') return actual[0] === expected[0] && actual[1] === expected[1] && compare() >= 0
  return compare() === 0
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
