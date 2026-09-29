/**
 * The layer files as one derived view: the protected set, the manifest
 * projection, the enabled-package set, the mutex groups, and the
 * requirement relations. The plugins rpc bridge and the invariant sidecar
 * both read through this module — one derivation of "what the layers say",
 * never two.
 *
 * @module @snap-rail/app-boot/layer-view
 */

import type { Context } from '@snap-rail/cordis'
import { loadBuiltinLayer, loadUserLayer, packageManifestOf, packageNameOf } from './compose.ts'
import type { LayerHandles } from './admin.ts'
import { scanPluginPool } from './scan.ts'
import type { PluginDescriptor } from './scan.ts'

/** The snapRail manifest projection a row's package declares. */
export interface ManifestInfo {
  kind?: string | undefined
  layer?: string | undefined
  title?: string | undefined
  category?: string | undefined
  exclusive?: string | undefined
  framework?: string | undefined
  clientOnly?: boolean | undefined
  requires?: readonly string[] | undefined
  /** Contributed seed ids this client face requires from other plugins. */
  externalSeeds?: readonly string[] | undefined
  capabilities?: {
    provides?: readonly { id: string, version: string }[]
    requires?: readonly { id: string, range: string, optional?: boolean }[]
  }
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
}

/** Everything the administration and diagnostic surfaces read from the layers. */
export interface LayerView {
  /** The protected set: builtin-layer rows, their packages, and the dev
   * harness's renderer occupants. Derived from the layer FILES, never from
   * manifest claims, so no zip can join it. */
  shippedNames(): ReadonlySet<string>
  /** The snapRail manifest projection of one row's package (pool manifest
   * wins; unresolvable or undeclared yields the empty projection). */
  manifestOf(name: string, pool?: ReadonlyMap<string, PluginDescriptor>): ManifestInfo
  /** The `snapRail.requires` list of a package (with the framework binding
   * merged in), always an array. */
  requirementsOf(name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[]
  /** The mutex group of a package (`snapRail.exclusive`, or the `suite`
   * kind default), or `undefined` when it shares with nobody. */
  groupOf(name: string, pool: ReadonlyMap<string, PluginDescriptor>): string | undefined
  /** Packages the layer files mount right now: builtin names with their
   * user-row patch applied, plus pool packages (and clientOnly renderer
   * rows) with an enabled user row. */
  enabledPackages(pool: ReadonlyMap<string, PluginDescriptor>): Set<string>
  /** Requirement names an enabled package cannot satisfy right now: a
   * package requirement nobody enabled, or a `service:` requirement with no
   * live service. Empty means safe. */
  missingRequirements(name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[]
  /** Capability requirements that no enabled provider satisfies. */
  missingCapabilities(name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[]
  /** Contributed seed ids the package requires that no installed provider
   * declares: the provider package is absent, or present without declaring
   * the id among its contributed seeds. */
  missingSeeds(name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[]
  /** Enabled packages that require one package (declared `requires` or
   * framework binding) — the reverse check for disable/uninstall. */
  dependentsOf(name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[]
}

/**
 * Derive the layer view for one set of handles. `serviceReady` resolves
 * `service:` requirements (the live cordis service table); without it every
 * `service:` requirement counts as unsatisfied.
 *
 * @param handles - the layer handles (file paths, pool dirs, app root).
 * @param serviceReady - liveness probe for `service:` requirement ids.
 */
export function createLayerView(
  handles: LayerHandles,
  serviceReady: (service: string) => boolean = () => false,
): LayerView {
  const shippedNames = (): ReadonlySet<string> => {
    const builtin = loadBuiltinLayer(handles.builtinLayerPath)
    return new Set<string>([
      ...builtin.map(entry => entry.name as string),
      ...builtin.map(entry => packageNameOf(entry.name as string)),
      ...handles.rendererPackages,
    ])
  }

  const manifestOf = (name: string, pool: ReadonlyMap<string, PluginDescriptor> = scanPluginPool(handles.poolDirs)): ManifestInfo => {
    const manifest = packageManifestOf(name, handles.appRoot, pool, shippedNames()) ?? {}
    const pick = (key: string): string | undefined => {
      const value = manifest[key]
      return typeof value === 'string' ? value : undefined
    }
    const requires = manifest.requires
    const capabilities = manifest.capabilities
    const parsedCapabilities = typeof capabilities === 'object' && capabilities !== null
      ? capabilities as ManifestInfo['capabilities']
      : undefined
    const engines = typeof manifest.engines === 'object' && manifest.engines !== null
      ? manifest.engines as ManifestInfo['engines']
      : undefined
    const client = typeof manifest.client === 'object' && manifest.client !== null
      ? manifest.client as { externalSeeds?: unknown }
      : undefined
    const externalSeeds = Array.isArray(client?.externalSeeds) && client.externalSeeds.every(entry => typeof entry === 'string')
      ? client.externalSeeds as readonly string[]
      : undefined
    return {
      kind: pick('kind'),
      layer: pick('layer'),
      title: pick('title'),
      category: pick('category'),
      exclusive: pick('exclusive'),
      framework: pick('framework'),
      clientOnly: manifest.clientOnly === true ? true : undefined,
      requires: Array.isArray(requires) && requires.every(entry => typeof entry === 'string') ? requires : undefined,
      ...(externalSeeds === undefined ? {} : { externalSeeds }),
      ...(parsedCapabilities === undefined ? {} : { capabilities: parsedCapabilities }),
      ...(engines === undefined ? {} : { engines }),
    }
  }

  const requiresOf = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] =>
    manifestOf(name, pool).requires ?? []

  const groupOf = (candidate: string, pool: ReadonlyMap<string, PluginDescriptor>): string | undefined => {
    const info = manifestOf(candidate, pool)
    return info.exclusive ?? (info.kind === 'suite' ? 'suite' : undefined)
  }

  const enabledPackages = (pool: ReadonlyMap<string, PluginDescriptor>): Set<string> => {
    const userRows = new Map(loadUserLayer(handles.userLayerPath).plugins.map(row => [row.name, row]))
    const enabled = new Set<string>()
    for (const entry of loadBuiltinLayer(handles.builtinLayerPath)) {
      const row = userRows.get(entry.name as string)
      if (row?.enabled === false) continue
      enabled.add(packageNameOf(entry.name as string))
    }
    for (const row of userRows.values()) {
      if (row.enabled === false) continue
      const pkg = packageNameOf(row.name)
      if (pool.has(pkg) || handles.rendererPackages.includes(row.name)) enabled.add(pkg)
    }
    return enabled
  }

  /** The package's requirements with the framework binding merged in —
   * a component without its framework never mounts, so the binding counts
   * as a package requirement everywhere. */
  const requirementsOf = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] => {
    const requirements = [...requiresOf(name, pool)]
    const framework = manifestOf(name, pool).framework
    if (framework !== undefined && !requirements.includes(framework)) requirements.push(framework)
    return requirements
  }

  const missingRequirements = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] => {
    const target = packageNameOf(name)
    const enabled = enabledPackages(pool)
    const missing: string[] = []
    for (const requirement of requirementsOf(target, pool)) {
      if (requirement.startsWith('service:')) {
        if (!serviceReady(requirement.slice('service:'.length))) missing.push(requirement)
      } else if (!enabled.has(packageNameOf(requirement))) {
        missing.push(requirement)
      }
    }
    return missing
  }

  const missingCapabilities = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] => {
    const requirements = manifestOf(name, pool).capabilities?.requires ?? []
    if (requirements.length === 0) return []
    const providers: Array<{ id: string, version: string }> = []
    for (const enabled of enabledPackages(pool)) {
      providers.push(...(manifestOf(enabled, pool).capabilities?.provides ?? []))
    }
    return requirements
      .filter(requirement => requirement.optional !== true && !providers.some(provider => provider.id === requirement.id && satisfiesRange(provider.version, requirement.range)))
      .map(requirement => `${requirement.id}@${requirement.range}`)
  }

  const missingSeeds = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] => {
    const target = packageNameOf(name)
    const missing: string[] = []
    for (const seed of manifestOf(target, pool).externalSeeds ?? []) {
      const provider = seedProviderOf(seed)
      if (!pool.has(provider)) {
        missing.push(`${seed}（提供方 ${provider} 未安装）`)
        continue
      }
      // Providers declare subpath keys (`seeds: ['ui']`); the required id is
      // the full `<package>/<key>`, so compare without the package prefix.
      const subpath = seed.slice(provider.length + 1)
      const declared = pool.get(provider)?.clientSeeds ?? []
      if (!declared.includes(subpath)) missing.push(`${seed}（提供方 ${provider} 未声明该贡献面）`)
    }
    return missing
  }

  const dependentsOf = (name: string, pool: ReadonlyMap<string, PluginDescriptor>): readonly string[] => {
    const target = packageNameOf(name)
    const dependents = new Set<string>()
    const provided = manifestOf(target, pool).capabilities?.provides ?? []
    for (const enabled of enabledPackages(pool)) {
      if (enabled === target) continue
      const requirements = [...requiresOf(enabled, pool)]
      const framework = manifestOf(enabled, pool).framework
      if (framework !== undefined) requirements.push(framework)
      if (requirements.some(requirement => !requirement.startsWith('service:') && packageNameOf(requirement) === target)) {
        dependents.add(enabled)
      }
      const capabilityRequirements = manifestOf(enabled, pool).capabilities?.requires ?? []
      if (capabilityRequirements.some(requirement => requirement.optional !== true
        && provided.some(capability => capability.id === requirement.id && satisfiesRange(capability.version, requirement.range)))) {
        dependents.add(enabled)
      }
    }
    return [...dependents]
  }

  return {
    shippedNames,
    manifestOf,
    requirementsOf,
    groupOf,
    enabledPackages,
    missingRequirements,
    missingCapabilities,
    missingSeeds,
    dependentsOf,
  }
}

/** The package that provides a contributed seed id: `@scope/pkg/sub` →
 * `@scope/pkg`, `pkg/sub` → `pkg`. An id without a subpath names itself and
 * can never be satisfied — seeds are subpath ids by definition. */
function seedProviderOf(seed: string): string {
  const firstSlash = seed.indexOf('/')
  if (firstSlash < 0) return seed
  if (seed.startsWith('@')) {
    const secondSlash = seed.indexOf('/', firstSlash + 1)
    return secondSlash < 0 ? seed : seed.slice(0, secondSlash)
  }
  return seed.slice(0, firstSlash)
}

function satisfiesRange(version: string, range: string): boolean {  const actual = parseVersion(version)
  const normalized = range.trim()
  const prefix = normalized.startsWith('^') || normalized.startsWith('~') || normalized.startsWith('>=') ? normalized.match(/^(\^|~|>=)/)?.[0] ?? '' : ''
  const expected = parseVersion(prefix === '>=' ? normalized.slice(2) : normalized.slice(prefix.length))
  if (prefix === '>=') return compareVersion(actual, expected) >= 0
  if (prefix === '^') return actual[0] === expected[0] && compareVersion(actual, expected) >= 0
  if (prefix === '~') return actual[0] === expected[0] && actual[1] === expected[1] && compareVersion(actual, expected) >= 0
  return compareVersion(actual, expected) === 0
}

function parseVersion(value: string): [number, number, number] {
  const parts = value.split(/[.-]/).slice(0, 3).map(item => /^\d+$/.test(item) ? Number(item) : 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1
  }
  return 0
}

/** Convenience the invariant sidecar re-exports so callers need no Context
 * typing ceremony: the view against a live tree's layer handles. */
export function liveLayerView(ctx: Context): LayerView {
  const layers = ctx.pluginLayers
  return createLayerView(layers.handles, service => ctx.get(service) !== undefined)
}
