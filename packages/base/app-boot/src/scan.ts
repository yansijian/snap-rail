/**
 * Plugin pool scan: discovers plugin packages available for mounting. The pool
 * answers "what exists on disk"; the entry list answers "what is mounted".
 *
 * @module @snap-rail/app-boot/scan
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Manifest fields snap-rail reads beyond the npm baseline. */
export interface SnapRailManifest {
  /** Reserved permission declarations; recorded but unenforced in phase 1. */
  permissions?: readonly string[]
  /** The package's declared kind: `suite` rows are mutually exclusive on enable. */
  kind?: string
  /** Source-governance layer; informational once a package is installed. */
  layer?: string
  /** The author-named display name shown by every listing surface. */
  title?: string
  /** The author-named classification marker shown by the management UI. */
  category?: string
  /** Mutex group: enabling a member deactivates the other enabled members. */
  exclusive?: string
  /**
   * Declared dependencies checked on enable/disable/uninstall — the single
   * compatibility declaration. Entries: a package name, a `name@range`
   * version-constrained package (`@snap-rail/util/semver` semantics; a
   * renderer face's framework binding IS a `requires` entry), or a
   * `service:` live-service id.
   */
  requires?: readonly string[]
  /** True when the package has no host face (renderer-only). */
  clientOnly?: boolean
  /** The renderer face: the client bundle path inside the package. */
  client?: {
    entry: string
    /** Contributed seed subpaths this face provides to other plugins. */
    seeds?: readonly string[]
    /** Contributed seed ids this face requires from other installed plugins. */
    externalSeeds?: readonly string[]
    /** The pack-stamped seed contract: the installer prechecks it against
     * the live table; the renderer boot re-checks it before loading. */
    seedAbi?: { revision: number, versions: Record<string, string> }
  }
  /** Supported snap-rail, Host protocol, and renderer versions. */
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** Key id recorded in the signed release envelope, when present. */
  signatureKeyId?: string
}

/**
 * One plugin package discovered by {@link scanPluginPool}.
 */
export interface PluginDescriptor {
  /** Package name from the manifest; the pool is keyed by it. */
  name: string
  /** Version from the manifest. */
  version: string
  /** Absolute directory containing the plugin package. */
  dir: string
  /** Module specifier the loader imports (a `file://` URL to the entry). */
  entryUrl: string
  /** Permission declarations from the `snapRail` manifest field. */
  permissions: readonly string[]
  /** The manifest's `snapRail.kind`, when declared. */
  kind?: string
  /** The manifest's `snapRail.layer`, when declared. */
  layer?: string
  /** The manifest's `snapRail.title`, when declared. */
  title?: string
  /** The manifest's `snapRail.category`, when declared. */
  category?: string
  /** The manifest's `snapRail.exclusive`, when declared. */
  exclusive?: string
  /** The manifest's `snapRail.requires`, when declared. */
  requires?: readonly string[]
  /** The manifest's `snapRail.clientOnly`, when declared. */
  clientOnly?: boolean
  /** The renderer bundle path (`snapRail.client.entry`), when declared. */
  clientEntry?: string
  /** Contributed seed subpaths (`snapRail.client.seeds`), when declared. */
  clientSeeds?: readonly string[]
  /** Contributed seed ids required from other plugins (`snapRail.client.externalSeeds`), when declared. */
  externalSeeds?: readonly string[]
  /** The pack-stamped seed contract (`snapRail.client.seedAbi`), when declared. */
  clientSeedAbi?: NonNullable<SnapRailManifest['client']>['seedAbi']
  /** Supported runtime versions. */
  engines?: SnapRailManifest['engines']
  /** Key id recorded in the signed release envelope, when present. */
  signatureKeyId?: string
}

interface PluginPackageJson {
  name?: unknown
  version?: unknown
  main?: unknown
  snapRail?: SnapRailManifest
}

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const stringArrayOrUndefined = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === 'string' && item !== '')
    ? value as readonly string[]
    : undefined

/**
 * Resolve one subpath (`'./rpc'`) inside a pool package directory: the
 * release manifest's `exports` voice when present, else `<subpath>.js` /
 * `<subpath>/index.js` on disk. Pure filesystem + JSON — never a nested
 * module resolution — so callers inside resolve hooks cannot recurse.
 *
 * @param packageDir - the pool package's directory.
 * @param subpath - the subpath specifier including its leading `./`.
 * @returns the entry file, or `undefined` when the package voices no such
 * subpath.
 */
export function poolSubpathFile(packageDir: string, subpath: string): string | undefined {
  const manifestPath = join(packageDir, 'package.json')
  let manifest: { main?: unknown, exports?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: unknown, exports?: unknown }
  } catch {
    return undefined
  }
  if (subpath === '.') {
    const main = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'lib/index.js'
    const file = join(packageDir, main)
    return existsSync(file) ? file : undefined
  }
  const exported = typeof manifest.exports === 'object' && manifest.exports !== null
    ? (manifest.exports as Record<string, unknown>)[subpath]
    : undefined
  if (typeof exported === 'string') {
    const file = join(packageDir, exported)
    return existsSync(file) ? file : undefined
  }
  for (const candidate of [`${subpath}.js`, join(subpath, 'index.js')]) {
    const file = join(packageDir, candidate)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * Scan pool directories for plugin packages.
 *
 * Each direct subdirectory with a `package.json` whose `name` is a string is a
 * plugin; anything else is skipped silently (the pool is a discovery surface,
 * not a validation gate). `node_modules` is never scanned.
 *
 * @param dirs - pool directories; missing ones are ignored.
 * @returns descriptors keyed by package name. Later directories win on name
 * collisions, so a user pool can shadow an identically-named built-in.
 */
export function scanPluginPool(dirs: readonly string[]): Map<string, PluginDescriptor> {
  const pool = new Map<string, PluginDescriptor>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const pluginDir = join(dir, entry.name)
      const manifestPath = join(pluginDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: PluginPackageJson
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginPackageJson
      } catch (cause) {
        throw new Error(`plugin pool: ${manifestPath} is not valid JSON`, { cause })
      }
      if (typeof manifest.name !== 'string' || manifest.name === '') continue
      const main = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'lib/index.js'
      const snapRail = manifest.snapRail
      const descriptor: PluginDescriptor = {
        name: manifest.name,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        dir: pluginDir,
        entryUrl: pathToFileURL(join(pluginDir, main)).href,
        permissions: snapRail?.permissions ?? [],
      }
      const kind = stringOrUndefined(snapRail?.kind)
      if (kind !== undefined) descriptor.kind = kind
      const layer = stringOrUndefined(snapRail?.layer)
      if (layer !== undefined) descriptor.layer = layer
      const title = stringOrUndefined(snapRail?.title)
      if (title !== undefined) descriptor.title = title
      const category = stringOrUndefined(snapRail?.category)
      if (category !== undefined) descriptor.category = category
      const exclusive = stringOrUndefined(snapRail?.exclusive)
      if (exclusive !== undefined) descriptor.exclusive = exclusive
      const requires = stringArrayOrUndefined(snapRail?.requires)
      if (requires !== undefined) descriptor.requires = requires
      if (snapRail?.clientOnly === true) descriptor.clientOnly = true
      const clientEntry = stringOrUndefined(snapRail?.client?.entry)
      if (clientEntry !== undefined) descriptor.clientEntry = clientEntry
      const clientSeeds = stringArrayOrUndefined(snapRail?.client?.seeds)
      if (clientSeeds !== undefined) descriptor.clientSeeds = clientSeeds
      const externalSeeds = stringArrayOrUndefined(snapRail?.client?.externalSeeds)
      if (externalSeeds !== undefined) descriptor.externalSeeds = externalSeeds
      if (snapRail?.client?.seedAbi !== undefined) descriptor.clientSeedAbi = snapRail.client.seedAbi
      if (snapRail?.engines !== undefined) descriptor.engines = snapRail.engines
      try {
        const signature = JSON.parse(readFileSync(join(pluginDir, 'META-INF', 'signature.json'), 'utf8')) as { keyId?: unknown }
        if (typeof signature.keyId === 'string' && signature.keyId !== '') descriptor.signatureKeyId = signature.keyId
      } catch {
        // Unsigned installs stay discoverable — the key id doubles as the
        // update anchor: a feed entry signed by a different key is flagged
        // keyChanged and never auto-applies.
      }
      pool.set(manifest.name, descriptor)
    }
  }
  return pool
}
