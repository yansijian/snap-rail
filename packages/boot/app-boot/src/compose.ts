/**
 * Two-layer entry composition: a read-only built-in entry list (shipped with
 * the app) plus the user layer (`plugins.yml`) applied as patches over it.
 * The composed list is what the loader mounts.
 *
 * @module @snap-rail/app-boot/compose
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { applyEntryPatches, type PatchOptions } from '@snap-rail/cordis-plugin-include'
import type { EntryOptions } from '@snap-rail/cordis-plugin-loader'
import type { PluginDescriptor } from './scan.ts'

/** One row of the user layer (`plugins.yml`). */
export interface UserPluginRow {
  /** Package name of the plugin; also its entry id in the composed list. */
  name: string
  /** Explicit on/off; absent means "default" (mounted if built-in, mounted if pool-only). */
  enabled?: boolean
  /** Whole-entry config replacement, applied to the built-in row or a pool insert. */
  config?: unknown
}

/** Parsed user layer document. */
export interface UserLayer {
  plugins: readonly UserPluginRow[]
}

/**
 * Load the built-in layer: a YAML array of loader entries (bare package names
 * plus their default config). The file ships with the application.
 *
 * @param path - absolute path of the built-in entry list.
 * @returns the parsed entry list; every row keeps its bare module name.
 * @throws when the file is missing or not a YAML array of entry rows.
 */
export function loadBuiltinLayer(path: string): EntryOptions[] {
  let parsed: unknown
  try {
    parsed = load(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`built-in layer: failed to parse ${path}`, { cause })
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`built-in layer: ${path} is not an entry list (expected a YAML array)`)
  }
  const entries: EntryOptions[] = []
  const seen = new Set<string>()
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') {
      throw new Error(`built-in layer: ${path} contains a non-object row`)
    }
    const options = row as Partial<EntryOptions>
    if (typeof options.name !== 'string' || options.name === '') {
      throw new Error(`built-in layer: ${path} contains a row without a name`)
    }
    const entry: EntryOptions = {
      id: options.id ?? options.name,
      name: options.name,
      ...options.config !== undefined ? { config: options.config } : {},
      ...options.disabled !== undefined ? { disabled: options.disabled } : {},
    }
    if (seen.has(entry.id)) {
      throw new Error(`built-in layer: duplicate entry id ${entry.id} in ${path}`)
    }
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

/**
 * Load the user layer. A missing file is a fresh home (nothing user-mounted);
 * a present file must parse as a document with a `plugins` array.
 *
 * @param path - absolute path of `plugins.yml`.
 * @returns the parsed user layer.
 */
export function loadUserLayer(path: string): UserLayer {
  // A missing file is a fresh home: nothing user-mounted, nothing to say.
  if (!existsSync(path)) return { plugins: [] }
  let parsed: unknown
  try {
    parsed = load(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`user layer: failed to parse ${path}`, { cause })
  }
  if (parsed === undefined || parsed === null) return { plugins: [] }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`user layer: ${path} is not a plugin list document`)
  }
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (plugins === undefined) return { plugins: [] }
  if (!Array.isArray(plugins)) {
    throw new Error(`user layer: ${path} has a non-array "plugins" key`)
  }
  const rows: UserPluginRow[] = []
  for (const row of plugins) {
    if (row === null || typeof row !== 'object' || typeof (row as UserPluginRow).name !== 'string') {
      throw new Error(`user layer: ${path} contains a row without a name`)
    }
    rows.push(row as UserPluginRow)
  }
  return { plugins: rows }
}

/**
 * Resolve a bare package name to a loadable module specifier.
 *
 * Pool hits (user plugin directories) resolve to their entry file. Everything
 * else resolves through the application's dependency tree (`appRoot`), which
 * owns the built-in plugin set. Built-in `cordis:` names and specifiers that
 * are already paths pass through untouched.
 *
 * @param name - the entry's module specifier from the composed list.
 * @param pool - discovered plugin descriptors.
 * @param appRoot - directory whose dependency tree resolves built-in names.
 * @returns the resolved specifier (a `file://` URL for absolute results).
 * @throws when a bare name resolves in neither the pool nor `appRoot`.
 */
export function resolveModuleSpecifier(
  name: string,
  pool: ReadonlyMap<string, PluginDescriptor>,
  appRoot: string,
): string {
  const fromPool = pool.get(name)
  if (fromPool !== undefined) return fromPool.entryUrl
  if (name.startsWith('cordis:') || name.startsWith('.') || name.startsWith('file:')) return name
  if (isAbsolute(name)) return pathToFileURL(name).href
  const require = createRequire(join(appRoot, 'package.json'))
  try {
    return pathToFileURL(require.resolve(name)).href
  } catch (cause) {
    throw new Error(`composition: cannot resolve plugin ${name} (not in the pool or the app tree at ${appRoot})`, { cause })
  }
}

/**
 * Compose the final entry list: built-in layer with user rows applied as
 * patches, every module name resolved to a loadable specifier.
 *
 * @param options - built-in entries, user layer, plugin pool, app root.
 * @returns the detached, fully resolved entry list for the loader.
 * @throws when a user row names a plugin present nowhere, or a patch lands on
 * an entry the pre-validation did not predict (composition drift).
 */
export function composeEntries(options: {
  builtin: readonly EntryOptions[]
  userLayer: UserLayer
  pool: ReadonlyMap<string, PluginDescriptor>
  appRoot: string
}): EntryOptions[] {
  // User rows address plugins by package name; patches land on entry ids
  // (which default to the name but may differ, e.g. mock-demo).
  const builtinByName = new Map(options.builtin.map(entry => [entry.name as string, entry]))
  const patches: PatchOptions[] = []
  for (const row of options.userLayer.plugins) {
    const builtin = builtinByName.get(row.name)
    if (builtin !== undefined) {
      const patch: PatchOptions = { id: builtin.id }
      if (row.config !== undefined) patch.config = row.config
      if (row.enabled === false) patch.disabled = true
      if (row.enabled === true) patch.disabled = false
      if (Object.keys(patch).length > 1) patches.push(patch)
      continue
    }
    if (options.pool.has(row.name)) {
      if (row.enabled === false) continue
      const entry: EntryOptions = {
        id: row.name,
        name: row.name,
        ...row.config !== undefined ? { config: row.config } : {},
      }
      patches.push({ insert: [entry] })
      continue
    }
    throw new Error(`user layer: plugin ${row.name} is neither built-in nor in the plugin pool`)
  }

  const composed = applyEntryPatches([...options.builtin], patches, (message, ...args) => {
    throw new Error(`composition: ${message} ${args.map(String).join(' ')}`)
  })
  return composed.map(entry => ({ ...entry, name: resolveModuleSpecifier(entry.name, options.pool, options.appRoot) }))
}
