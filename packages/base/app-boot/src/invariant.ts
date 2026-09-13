/**
 * The layer invariant sidecar: a diagnostic plugin that checks the
 * "always-true" rules of the layer files and reports violations as data —
 * never throws, never writes, never unmounts anything. Mount it explicitly
 * through a `plugins.yml` row (`@snap-rail/app-boot/invariant`) when a home
 * is suspected of drift; unlisted it costs nothing and never ships in a
 * default composition.
 *
 * Checked rules: every user row must resolve somewhere (the composition
 * would refuse the whole file); each mutex group holds at most one enabled
 * package; every enabled package's requirements are satisfiable right now.
 *
 * @module @snap-rail/app-boot/invariant
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { loadBuiltinLayer, loadUserLayer, packageNameOf } from './compose.ts'
import { createLayerView } from './layer-view.ts'
import type { LayerHandles } from './admin.ts'
import { scanPluginPool } from './scan.ts'

declare module '@snap-rail/cordis' {
  interface Events {
    /** The invariant sidecar found layer-file violations.
     * @param violations - every violation found in the current pass. */
    'plugin-layers/invariant-violations'(violations: readonly LayerInvariantViolation[]): void
  }
}

/** One broken "always-true" rule of the layer files. */
export interface LayerInvariantViolation {
  /** The rule that broke. */
  code: 'unresolvable-row' | 'mutex-conflict' | 'missing-requirement'
  /** The row or package the violation attaches to (empty for a group). */
  name: string
  /** Human-readable detail (Chinese, operator-facing). */
  detail: string
}

/**
 * Check the layer files' always-true rules and return every violation.
 * Pure read: layers and pool are scanned, nothing is written or mounted.
 *
 * @param handles - the layer handles (the same object `ctx.pluginLayers` carries).
 * @param serviceReady - liveness probe for `service:` requirements; absent,
 * every service requirement counts as unsatisfied.
 */
export function collectLayerViolations(
  handles: LayerHandles,
  serviceReady: (service: string) => boolean = () => false,
): readonly LayerInvariantViolation[] {
  const pool = scanPluginPool(handles.poolDirs)
  const view = createLayerView(handles, serviceReady)
  const violations: LayerInvariantViolation[] = []

  // Every user row must name something the composition could resolve; the
  // compositor throws the whole file away on a stranger, so drift here
  // silently freezes hot reloads — naming it is the sidecar's main job.
  const resolvable = new Set<string>([
    ...loadBuiltinLayer(handles.builtinLayerPath).map(entry => entry.name as string),
    ...handles.rendererPackages,
    ...[...pool.keys()],
  ])
  for (const row of loadUserLayer(handles.userLayerPath).plugins) {
    const pkg = packageNameOf(row.name)
    if (resolvable.has(row.name) || pool.has(pkg)) continue
    violations.push({
      code: 'unresolvable-row',
      name: row.name,
      detail: `行 ${row.name} 既不内置也不在插件池中（组合会拒绝整个 plugins.yml）`,
    })
  }

  // One mutex group, at most one enabled member.
  const groupMembers = new Map<string, string[]>()
  for (const enabled of view.enabledPackages(pool)) {
    const group = view.groupOf(enabled, pool)
    if (group === undefined) continue
    const members = groupMembers.get(group) ?? []
    members.push(enabled)
    groupMembers.set(group, members)
  }
  for (const [group, members] of groupMembers) {
    if (members.length <= 1) continue
    violations.push({
      code: 'mutex-conflict',
      name: group,
      detail: `互斥组 ${group} 同时启用了 ${members.length} 个包：${members.join('、')}`,
    })
  }

  // Every enabled package's requirements must be satisfiable now.
  for (const enabled of view.enabledPackages(pool)) {
    const missing = view.missingRequirements(enabled, pool)
    if (missing.length === 0) continue
    violations.push({
      code: 'missing-requirement',
      name: enabled,
      detail: `已启用的 ${enabled} 缺少依赖：${missing.join('、')}`,
    })
  }

  return violations
}

/** The invariant sidecar plugin; mount after boot (it reads `pluginLayers`). */
const layerInvariantPlugin: Plugin.Object<void> = {
  name: 'app-boot-invariant',
  inject: ['pluginLayers'],
  apply(ctx: Context): void {
    const report = (): void => {
      const violations = collectLayerViolations(ctx.pluginLayers.handles, service => ctx.get(service) !== undefined)
      if (violations.length === 0) return
      const logger = ctx.logger('app-boot-invariant')
      for (const violation of violations) logger.warn?.(`${violation.code}: ${violation.detail}`)
      ctx.emit('plugin-layers/invariant-violations', violations)
    }

    report()
    // Re-check after every hot apply — the drift this diagnoses arrives
    // exactly through hand edits and pool drops.
    ctx.on('plugin-layers/applied', () => report())
  },
}

export default layerInvariantPlugin
