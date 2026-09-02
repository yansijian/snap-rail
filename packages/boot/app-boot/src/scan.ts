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
  /** The renderer face: the client bundle path inside the package. */
  client?: { entry: string }
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
  /** The renderer bundle path (`snapRail.client.entry`), when declared. */
  clientEntry?: string
}

interface PluginPackageJson {
  name?: unknown
  version?: unknown
  main?: unknown
  snapRail?: SnapRailManifest
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
      pool.set(manifest.name, {
        name: manifest.name,
        version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        dir: pluginDir,
        entryUrl: pathToFileURL(join(pluginDir, main)).href,
        permissions: manifest.snapRail?.permissions ?? [],
        ...(typeof manifest.snapRail?.kind === 'string' ? { kind: manifest.snapRail.kind } : {}),
        ...(typeof manifest.snapRail?.client?.entry === 'string' ? { clientEntry: manifest.snapRail.client.entry } : {}),
      })
    }
  }
  return pool
}
