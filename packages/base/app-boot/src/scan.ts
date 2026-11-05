/**
 * Plugin pool scan: discovers plugin packages available for mounting. The pool
 * answers "what exists on disk"; the entry list answers "what is mounted".
 *
 * @module @snap-rail/app-boot/scan
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  /** The author's declared relationship to the skin contract. */
  uiProfile?: string
  /** True when the package has no host face (renderer-only). */
  clientOnly?: boolean
  /** The renderer face: the client bundle path inside the package. */
  client?: {
    entry: string
    /** Auxiliary-surface client entries (`ball`): one bundle per
     * extra window this package renders in. `main` is never a key here — it
     * is `entry`. */
    surfaces?: Partial<Record<string, string>>
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
  /** The manifest's `snapRail.uiProfile`, when declared. */
  uiProfile?: string
  /** The manifest's `snapRail.clientOnly`, when declared. */
  clientOnly?: boolean
  /** The renderer bundle path (`snapRail.client.entry`), when declared. */
  clientEntry?: string
  /** Contributed seed subpaths (`snapRail.client.seeds`), when declared. */
  clientSeeds?: readonly string[]
  /** Contributed seed ids required from other plugins (`snapRail.client.externalSeeds`), when declared. */
  externalSeeds?: readonly string[]
  /** Auxiliary-surface client entries (`snapRail.client.surfaces`), when declared. */
  clientSurfaces?: NonNullable<SnapRailManifest['client']>['surfaces']
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
 * Build the loadable URL for a pool entry script with a content-addressed
 * query. The loader imports entries by URL and Node keys the ESM module cache
 * on the full URL, so a rebuilt face at the same path would keep serving the
 * cached module forever — both the reinstall-update path (uninstall + install
 * while the app runs) and the dev sync loop hit this. The query changes
 * exactly when the face's script bytes change (the entry update then disposes
 * the old fiber and re-imports the fresh module) and stays put otherwise, so
 * unchanged packages never re-mount.
 *
 * The digest covers every script file under the entry's directory (shared
 * chunks land beside the entry); assets never affect host imports. The
 * computation is deterministic, so every consumer resolving the same file
 * (the composition, the resolve-hook pool fallback) derives the same URL and
 * the package keeps a single module instance.
 *
 * @param entryFile - absolute path of the entry script inside a pool package.
 * @returns the `file://` URL with `?v=<digest>`; a plain URL when the
 * directory is unreadable (the import then fails loudly on its own).
 */
export function poolEntryUrl(entryFile: string): string {
  const href = pathToFileURL(entryFile).href
  try {
    const hash = createHash('sha1')
    const walk = (dir: string, prefix: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel)
        } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
          hash.update(rel)
          hash.update(readFileSync(join(dir, entry.name)))
        }
      }
    }
    walk(dirname(entryFile), '')
    return `${href}?v=${hash.digest('hex').slice(0, 12)}`
  } catch {
    return href
  }
}

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
        entryUrl: poolEntryUrl(join(pluginDir, main)),
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
      const uiProfile = stringOrUndefined(snapRail?.uiProfile)
      if (uiProfile !== undefined) descriptor.uiProfile = uiProfile
      if (snapRail?.clientOnly === true) descriptor.clientOnly = true
      const clientEntry = stringOrUndefined(snapRail?.client?.entry)
      if (clientEntry !== undefined) descriptor.clientEntry = clientEntry
      const clientSeeds = stringArrayOrUndefined(snapRail?.client?.seeds)
      if (clientSeeds !== undefined) descriptor.clientSeeds = clientSeeds
      const externalSeeds = stringArrayOrUndefined(snapRail?.client?.externalSeeds)
      if (externalSeeds !== undefined) descriptor.externalSeeds = externalSeeds
      if (snapRail?.client?.surfaces !== undefined) descriptor.clientSurfaces = snapRail.client.surfaces
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
