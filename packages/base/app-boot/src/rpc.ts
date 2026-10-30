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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump } from 'js-yaml'
import { satisfiesRange, splitNameRange } from '@snap-rail/util/semver'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import { pluginsContract, pluginUpdatesChangedSchema, type InspectedArchive, type InspectedPlugin, type PluginInfo, type PluginSource } from './contract.ts'
import {
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
  downloadPluginZipFromUrl,
  downloadRemotePluginZip,
  fetchRemoteCatalogs,
  mergeCatalogs,
  FeedError,
  resolvePluginFeedUrls,
  resolveSignaturePolicy,
  updatableFromCatalog,
  type PendingUpdate,
  type SourcedCatalogEntry,
} from './feed.ts'
import { archiveKind, inspectComboZip } from './combo.ts'
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
import { resolveSeedAbi } from './seed-abi.ts'

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
    /** Factory defaults that a pool package in the same mutex group may replace. */
    const defaultNames = new Set(
      loadBuiltinLayer(layers.handles.builtinLayerPath)
        .filter(entry => entry.default === true)
        .flatMap(entry => [entry.name as string, packageNameOf(entry.name as string)]),
    )

    rpc.claimDomain(ctx, 'plugins')
    // The auto-update announcement frame: the sweep carries the pending
    // set, an apply empties it.
    rpc.frame(ctx, 'plugins/updates-changed', { payload: pluginUpdatesChangedSchema })

    const assertNotBase = (name: string, allowDefault = false): void => {
      const target = packageNameOf(name)
      if (!allowDefault && (defaultNames.has(target) || defaultNames.has(name))) {
        throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`内置默认插件禁止删除/改配置：${target}`] } })
      }
      const shipped = view.shippedNames()
      if (shipped.has(target) || shipped.has(name)) {
        throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`内置插件禁止删除/修改：${target}`] } })
      }
    }

    /**
     * Forward check before an enable lands: every declared requirement must
     * be satisfiable now — a package requirement by an enabled package (with
     * its `@range` satisfied when declared), a `service:` requirement by a
     * live service, a contributed seed by an installed provider that
     * declares it.
     */
    const assertRequirementsMet = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): void => {
      const missing = view.missingRequirements(name, pool)
      const missingSeeds = view.missingSeeds(name, pool)
      const issues = [
        ...(missing.length > 0
          ? [`缺少依赖：${missing.join('、')}`]
          : []),
        ...(missingSeeds.length > 0 ? [`缺少贡献面：${missingSeeds.join('、')}`] : []),
      ]
      if (issues.length > 0) {
        throw new RpcBusinessError({ code: 'bad-request', details: { issues } })
      }
    }

    /** The configured feed base URLs (user list, factory default fallback —
     * via `resolvePluginFeedUrls`): the plugins domain must not couple to the
     * settings service's lifecycle — it is the uninstall path of the
     * settings package itself. An unset key with no default reads as "no
     * feed configured". */
    const feedUrls = (): readonly string[] => {
      const value = resolvePluginFeedUrls(dirname(layers.handles.userLayerPath), dirname(layers.handles.builtinLayerPath))
      if (value === undefined || value.length === 0) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: '未配置插件源' } })
      }
      return value
    }

    /** The install-time signature gate (`open` default; `strict` via
     * settings or the factory defaults layer). */
    const signaturePolicy = (): 'open' | 'strict' =>
      resolveSignaturePolicy(dirname(layers.handles.userLayerPath), dirname(layers.handles.builtinLayerPath))

    /** The first pool directory; every install path lands there. */
    const poolDirOf = (): string => {
      const poolDir = layers.handles.poolDirs[0]
      if (poolDir === undefined) {
        throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no plugin pool is configured' } })
      }
      return poolDir
    }

    const trustedKeys = (): readonly import('@snap-rail/plugin-kit/sign').TrustedReleaseKey[] =>
      loadTrustedReleaseKeys(dirname(layers.handles.userLayerPath), dirname(layers.handles.builtinLayerPath))

    /** Every installed package whose highest feed version is strictly
     * higher — the auto-update candidate set (the manual update's own
     * rule). Rows whose signing key changed against the installed copy
     * carry `keyChanged`; the auto apply skips those. */
    const computeUpdatable = async (feedUrls: readonly string[], poolDir: string): Promise<PendingUpdate[]> => {
      const merged = mergeCatalogs(await fetchRemoteCatalogs(feedUrls))
      const pool = scanPluginPool([poolDir])
      return updatableFromCatalog(merged, name => installedVersionOf(poolDir, name), name => pool.get(name)?.signatureKeyId)
    }

    /** Map feed fetch failures onto the wire's business codes. */
    const feedCall = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run()
      } catch (cause) {
        if (cause instanceof FeedError) {
          if (cause.kind === 'bad-catalog' || cause.kind === 'bad-url' || cause.kind === 'too-large') {
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

    /** The shared install pipeline: local zips and feed downloads land here
     * — capture the previous version, install (strictly-higher rule,
     * built-in names refused), audit. The caller owns the composition
     * refresh (`runInstall` applies; a combo install proceeds as one
     * transaction and applies once at the end). Returns the wire shape. */
    const installOne = async (zipPath: string, via?: string): Promise<{ installed: { name: string, version: string, updated: boolean } }> => {
      const poolDir = poolDirOf()
      // The installed version must be read before the swap replaces it; the
      // pre-read is best-effort (the install validates and reports its own
      // errors, and `updated` stays the authority).
      const previous = (() => {
        try {
          return installedVersionOf(poolDir, inspectPluginZip(zipPath, { trustedKeys: trustedKeys(), signaturePolicy: signaturePolicy() }).name)
        } catch {
          return undefined
        }
      })()
      let installed: { name: string, version: string, updated: boolean }
      try {
        installed = installPluginFromZip(zipPath, poolDir, {
          reserved: [...view.reservedNames()],
          trustedKeys: trustedKeys(),
          signaturePolicy: signaturePolicy(),
          seedAbi: await resolveSeedAbi(layers.handles.appRoot),
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
      // An address-install consumed its preview slot — sweep the temp file.
      if (pendingUrlZip === zipPath) {
        rmSync(zipPath, { force: true })
        pendingUrlZip = undefined
      }
      // Project to the wire shape — the host-absolute staging dir stays host-side.
      return { installed: { name: installed.name, version: installed.version, updated: installed.updated } }
    }

    /** One local/feed install plus the composition refresh the UI observes. */
    const runInstall = async (zipPath: string, via?: string): Promise<{ installed: { name: string, version: string, updated: boolean } }> => {
      const result = await installOne(zipPath, via)
      // The pool watch may race the explicit apply; both paths converge on
      // the same composition, and the pool scan now sees the package.
      await mutate(async () => {
        await layers.apply()
      })
      return result
    }

    // The temp file behind the latest `plugins.inspect-from-url` preview:
    // one preview slot at a time — a new download retires the old file, the
    // matching install consumes it, and dispose sweeps whatever a cancelled
    // preview left behind.
    let pendingUrlZip: string | undefined
    ctx.effect(() => () => {
      if (pendingUrlZip !== undefined) {
        rmSync(pendingUrlZip, { force: true })
        pendingUrlZip = undefined
      }
    })

    /** Inspect a zip (a local path or a downloaded direct-URL temp file):
     * identity, permissions, dependency warnings, and how the install would
     * land — everything the confirmation dialog shows. */
    const inspectZip = (zipPath: string): InspectedPlugin => {
      const plugin = inspectPluginZip(zipPath, { trustedKeys: trustedKeys(), signaturePolicy: signaturePolicy() })
      // Package requirements the home cannot satisfy yet surface as install
      // warnings: not installed (neither pool nor app tree), or installed at
      // a version missing the declared range. Service requirements are
      // runtime facts, not install-time ones.
      const pool = scanPluginPool(layers.handles.poolDirs)
      const missing = plugin.requires
        .filter(entry => !entry.startsWith('service:'))
        .filter(entry => {
          const { name, range } = splitNameRange(entry)
          if (!pool.has(name)) return true
          if (range === undefined) return false
          const installed = pool.get(name)?.version
          return installed !== undefined && !satisfiesRange(installed, range)
        })
      // Contributed seeds ride the install warning path (not a refusal):
      // a missing provider is exactly what the next install fixes, and the
      // enable precheck still refuses before mount.
      const missingSeeds = plugin.externalSeeds
        .filter(seed => {
          const provider = seed.split('/').slice(0, seed.startsWith('@') ? 2 : 1).join('/')
          return !pool.has(provider)
        })
        .map(seed => `${seed}（提供方未安装）`)
      const missingAll = [...missing, ...missingSeeds]
      // How the install would land over the installed version drives the
      // confirmation dialog's update/block branches.
      const poolDir = layers.handles.poolDirs[0]
      const installedVersion = poolDir === undefined ? undefined : installedVersionOf(poolDir, plugin.name)
      if (installedVersion === undefined) {
        return { ...plugin, missing: missingAll, action: 'install' as const }
      }
      const action = compareVersions(plugin.version, installedVersion) > 0
        ? ('update' as const)
        : ('blocked' as const)
      return { ...plugin, missing: missingAll, action, installed: { version: installedVersion } }
    }

    /** Inspect any archive: a plugin gets the pool verdicts of `inspectZip`;
     * a combo gets each member's own signature and landing action plus the
     * aggregate missing requirements. The combo's member zips are extracted
     * to a temp dir for inspection only and swept before returning — the
     * install path re-reads the original archive. */
    const inspectArchive = (zipPath: string): InspectedArchive => {
      if (archiveKind(zipPath) === 'combo') {
        const poolDir = layers.handles.poolDirs[0]
        const shipped = view.reservedNames()
        const inspection = inspectComboZip(zipPath, {
          trustedKeys: trustedKeys(),
          signaturePolicy: signaturePolicy(),
          installedVersionOf: name => poolDir === undefined ? undefined : installedVersionOf(poolDir, name),
          shipped: name => shipped.has(name) || shipped.has(packageNameOf(name)),
        })
        try {
          return { kind: 'combo', combo: inspection.combo }
        } finally {
          rmSync(inspection.archive.dir, { recursive: true, force: true })
        }
      }
      return { kind: 'plugin', plugin: inspectZip(zipPath) }
    }

    /** The pending-update set folded onto the frame's wire shape. */
    const toWireUpdate = (update: PendingUpdate) => ({
      name: update.name,
      installedVersion: update.installedVersion,
      feedVersion: update.feedVersion,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.keyChanged === true ? { keyChanged: true } : {}),
    })

    /** Every configured feed's catalog merged into one entry list (per
     * name the highest version wins, rows carry their source). */
    const mergedCatalog = async (): Promise<readonly SourcedCatalogEntry[]> =>
      mergeCatalogs(await fetchRemoteCatalogs(feedUrls()))

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
          const { kind, layer, title, category, exclusive, uiProfile, clientOnly, requires, engines } = view.manifestOf(name, pool)
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
            ...(uiProfile !== undefined ? { uiProfile } : {}),
            ...(clientOnly ? { clientOnly: true } : {}),
            ...(requires !== undefined && requires.length > 0 ? { requires } : {}),
            ...(engines === undefined ? {} : { engines }),
            ...(signatureKeyId === undefined ? {} : { signatureKeyId }),
            ...config !== undefined ? { config } : {},
          }
        }
        for (const entry of builtin) {
          seen.add(entry.name as string)
          const live = composed.get(entry.id as string)
          infos.push(toInfoFor(
            entry.name as string,
            entry.default === true ? 'builtin-default' : 'builtin',
            live?.disabled !== true,
            live?.config,
          ))
        }
        for (const row of user.plugins) {
          if (seen.has(row.name)) continue
          const inPool = pool.has(row.name) || pool.has(packageNameOf(row.name))
          if (!inPool && !layers.handles.rendererPackages.includes(row.name)) continue
          seen.add(row.name)
          const live = composed.get(row.name)
          // Pool-resident packages report their physical origin ('pool') and
          // their real mounted state: a disabled pool entry is omitted from the
          // composition entirely, so presence in it is the truth. Client-only
          // pool packages never join the composition either (their face rides
          // `client-config.list`, not the host tree), so their row's flag is
          // the truth — same for renderer rows, which are config-only.
          const clientOnly = pool.get(row.name)?.clientOnly === true || pool.get(packageNameOf(row.name))?.clientOnly === true
          const enabled = inPool && !clientOnly ? composed.has(row.name) : row.enabled !== false
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
            // Client-only pool packages never join the composition — the
            // preset row's flag is their mounted truth.
            const enabled = entry.clientOnly === true ? presetRow.enabled !== false : composed.has(name)
            infos.push(toInfoFor(name, 'preset', enabled, presetRow.config, entry.version))
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
        })).filter(row => row.requirements.length > 0)
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
        assertNotBase(name, true)
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
              details: { issues: [`还有已启用的插件依赖 ${packageNameOf(name)}：${dependents.join('、')}`] },
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
        } else {
          const target = packageNameOf(name)
          const group = view.groupOf(target, pool)
          if (group !== undefined) {
            const remaining = [...view.enabledPackages(pool)].filter(candidate => {
              if (candidate === target) return false
              return view.groupOf(candidate, pool) === group
            })
            if (defaultNames.has(target) && remaining.length === 0) {
              throw new RpcBusinessError({
                code: 'bad-request',
                details: { issues: [`${target} 是内置默认，需先启用同组替代插件`] },
              })
            }
            if (remaining.length === 0) {
              const fallback = loadBuiltinLayer(layers.handles.builtinLayerPath)
                .find(entry => entry.default === true && view.groupOf(packageNameOf(entry.name as string), pool) === group)
              if (fallback !== undefined && packageNameOf(fallback.name as string) !== target) {
                edits.push({ name: fallback.name as string, enabled: true })
              }
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

      'plugins.install-combo': async ({ zipPath }) => {
        const poolDir = poolDirOf()
        const presetDir = layers.handles.presetDirs[0]
        if (presetDir === undefined) {
          throw new RpcBusinessError({ code: 'unavailable', details: { what: 'no preset directory is configured' } })
        }
        const shipped = view.reservedNames()
        // Re-read the original archive: the preview's member zips were swept
        // when its inspection returned, and installs must consume a fresh,
        // digest-free local archive exactly as handed in.
        const inspection = inspectComboZip(zipPath, {
          trustedKeys: trustedKeys(),
          signaturePolicy: signaturePolicy(),
          installedVersionOf: name => installedVersionOf(poolDir, name),
          shipped: name => shipped.has(name) || shipped.has(packageNameOf(name)),
        })
        const { combo, archive } = inspection
        try {
          if (combo.missing.length > 0) {
            throw new RpcBusinessError({
              code: 'bad-request',
              details: { issues: [`组合依赖未满足：${combo.missing.join('、')}`] },
            })
          }
          // Unique packages in row order; install only what the pool lacks
          // or holds at a strictly lower version — `current`/`local-newer`
          // members stay exactly as the user has them.
          const targets = combo.plugins.filter(plugin => plugin.action === 'install' || plugin.action === 'update')
          const presetPath = join(presetDir, recipePresetFileName(combo.id))
          const previousPreset = existsSync(presetPath) ? readFileSync(presetPath, 'utf8') : undefined
          const installed: Array<{ name: string, version: string, updated: boolean }> = []
          try {
            await withPluginPoolTransaction(poolDir, targets.map(target => target.name), async () => {
              for (const target of targets) {
                const member = archive.members.find(candidate => candidate.name === target.name)
                if (member === undefined) {
                  throw new InstallError('bad-combo', `组合包缺少 ${target.name} 的插件 zip`)
                }
                installed.push((await installOne(member.zipPath, 'combo')).installed)
              }
              // The preset is part of the same combo transaction: a failed
              // write or compose must restore both the pool and the previous
              // combination, otherwise the next boot sees a half-installed
              // combo.
              mkdirSync(presetDir, { recursive: true })
              atomicWrite(presetPath, dump({
                plugins: archive.recipe.plugins.map(row => ({
                  name: row.name,
                  ...(row.enabled !== undefined ? { enabled: row.enabled } : {}),
                  ...(row.config !== undefined ? { config: row.config } : {}),
                })),
              } satisfies UserLayer))
              await mutate(async () => {
                await layers.apply()
              })
            })
          } catch (cause) {
            // The filesystem transaction restored the prior pool. Restore the
            // prior preset too, then recompose the old tree before surfacing
            // the failed combo operation.
            if (previousPreset === undefined) rmSync(presetPath, { force: true })
            else atomicWrite(presetPath, previousPreset)
            try { await layers.apply() } catch { /* preserve the original failure */ }
            throw cause
          }
          audit.record({
            actor: 'client',
            action: 'combo.install',
            subject: combo.id,
            detail: {
              version: combo.version,
              ...(installed.length > 0 ? { installed: installed.map(entry => `${entry.name}@${entry.version}`) } : {}),
            },
          })
          // A successful direct-URL combo install consumed its preview slot.
          if (pendingUrlZip === zipPath) {
            rmSync(zipPath, { force: true })
            pendingUrlZip = undefined
          }
          return { installed, preset: recipePresetFileName(combo.id) } as const
        } finally {
          // The extracted member zips are temporary staging only.
          rmSync(archive.dir, { recursive: true, force: true })
        }
      },

      'plugins.inspect': ({ zipPath }) => {
        try {
          return { archive: inspectArchive(zipPath) }
        } catch (cause) {
          throw new RpcBusinessError({
            code: 'bad-request',
            details: { issues: [cause instanceof Error ? cause.message : String(cause)] },
          })
        }
      },

      'plugins.inspect-from-url': async ({ url }) => {
        // One preview at a time: each download retires the previous temp
        // file, and the install (or the plugin's dispose) clears the slot —
        // a cancelled preview leaks at most one bounded temp file per run.
        if (pendingUrlZip !== undefined) {
          rmSync(pendingUrlZip, { force: true })
          pendingUrlZip = undefined
        }
        const zipPath = await feedCall(() => downloadPluginZipFromUrl(url))
        pendingUrlZip = zipPath
        try {
          return { archive: inspectArchive(zipPath), zipPath }
        } catch (cause) {
          pendingUrlZip = undefined
          rmSync(zipPath, { force: true })
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
            details: { issues: [`还有已启用的插件依赖 ${packageNameOf(name)}：${dependents.join('、')}`] },
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
            details: { what: `预设正在使用 ${name}，无法卸载` },
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
        const feeds = feedUrls()
        const poolDir = poolDirOf()
        const merged = await feedCall(() => fetchRemoteCatalogs(feeds).then(mergeCatalogs))
        return { plugins: annotateCatalog(merged, poolDir), feedUrls: feeds }
      },

      'plugins.remote-install': async ({ name }) => {
        // The zip coordinates resolve only from the freshly fetched catalog
        // — the client names a plugin, never a download location.
        const catalog = await feedCall(mergedCatalog)
        const entry = catalog.find(candidate => candidate.name === name)
        if (entry === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `${name} 不在插件源目录中` } })
        }
        const zipPath = await feedCall(() => downloadRemotePluginZip(entry.feedUrl, entry, entry.sha256))
        try {
          return await runInstall(zipPath, 'feed')
        } finally {
          rmSync(zipPath, { force: true })
        }
      },

      'plugins.updates-check': async () => {
        const feeds = feedUrls()
        const poolDir = poolDirOf()
        const updates = await feedCall(() => computeUpdatable(feeds, poolDir))
        return { updates: updates.map(toWireUpdate), feedUrls: feeds }
      },

      'plugins.auto-update-apply': async () => {
        const feeds = feedUrls()
        const poolDir = poolDirOf()
        const updates = await feedCall(() => computeUpdatable(feeds, poolDir))
        // The key-anchored gate: a background apply only ever lands an
        // update signed by the same key the installed copy carries (or by
        // the trusted org key — that verdict rode the original install).
        // A key change is a human decision; those rows stay pending for the
        // manual pill's confirm dialog.
        const applicable = updates.filter(update => update.keyChanged !== true)
        const applied: Array<{ name: string, from: string, to: string }> = []
        if (applicable.length > 0) {
          await withPluginPoolTransaction(poolDir, applicable.map(update => update.name), async () => {
            for (const update of applicable) {
              const zipPath = await feedCall(() => downloadRemotePluginZip(update.feedUrl, update, update.sha256))
              try {
                await runInstall(zipPath, 'auto-update')
                applied.push({ name: update.name, from: update.installedVersion, to: update.feedVersion })
              } finally {
                rmSync(zipPath, { force: true })
              }
            }
            await mutate(async () => {
              await layers.apply()
            })
          })
        }
        // The anchored set is spent — keyChanged rows (if any) stay pending.
        rpc.broadcast('plugins/updates-changed', { updates: updates.filter(update => update.keyChanged === true).map(toWireUpdate) })
        audit.record({
          actor: 'client',
          action: 'plugin.auto-update',
          subject: applied.map(entry => `${entry.name}@${entry.to}`).join(','),
        })
        return { applied }
      },
    })

    // ---- plugin auto-update: a boot sweep (15s in) + an hourly sweep. The
    // sweep only checks and announces (the frame carries the pending set);
    // the actual apply is the user-confirmed `plugins.auto-update-apply` —
    // a running terminal hot-applies, no restart needed. An unreachable or
    // malformed feed stays silent; the next sweep retries.
    let sweeping = false
    const sweep = (): void => {
      if (sweeping) return
      sweeping = true
      void (async () => {
        try {
          const home = dirname(layers.handles.userLayerPath)
          if (readAutoUpdateEnabled(home) === false) return
          const feedUrls = resolvePluginFeedUrls(home, dirname(layers.handles.builtinLayerPath))
          const poolDir = layers.handles.poolDirs[0]
          if (feedUrls === undefined || poolDir === undefined) return
          const updates = await computeUpdatable(feedUrls, poolDir)
          if (updates.length > 0) {
            rpc.broadcast('plugins/updates-changed', { updates: updates.map(toWireUpdate) })
          }
        } catch {
          // Silence is the contract here: the plugins page's manual path
          // surfaces real errors, the sweep just keeps the light on.
        } finally {
          sweeping = false
        }
      })()
    }
    const bootSweep = setTimeout(sweep, 15_000)
    const sweepTimer = setInterval(sweep, 3_600_000)
    ctx.effect(() => () => {
      clearTimeout(bootSweep)
      clearInterval(sweepTimer)
    })
  },
}

/** The `plugins.autoUpdate` settings flag (default on), read straight from
 * `<home>/settings.json` — the plugins domain reads settings.json directly
 * for the same lifecycle-decoupling reason the feed URL does. */
function readAutoUpdateEnabled(home: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
    return (parsed as Record<string, unknown>)['plugins.autoUpdate'] !== false
  } catch {
    return true
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
