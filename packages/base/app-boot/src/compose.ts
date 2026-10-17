/**
 * Two-layer entry composition: a read-only built-in entry list (shipped with
 * the app) plus the user layer (`plugins.yml`) applied as patches over it.
 * The composed list is what the loader mounts.
 *
 * @module @snap-rail/app-boot/compose
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { applyEntryPatches, type PatchOptions } from '@snap-rail/cordis-plugin-include'
import type { EntryOptions } from '@snap-rail/cordis-plugin-loader'
import { poolSubpathFile, type PluginDescriptor } from './scan.ts'

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
 * The npm package a plugin row belongs to: a scoped name keeps its first two
 * segments (`@scope/pkg/sub` → `@scope/pkg`); anything else (`cordis:`
 * specifiers, bare names, paths) is its own group. The management page groups
 * rows by this so one package's entries share a single master toggle.
 *
 * @param name - a row name (package name or subpath entry name).
 * @returns the package part of the name.
 */
export function packageNameOf(name: string): string {
  if (!name.startsWith('@')) return name
  const firstSlash = name.indexOf('/')
  if (firstSlash < 0) return name
  const secondSlash = name.indexOf('/', firstSlash + 1)
  return secondSlash < 0 ? name : name.slice(0, secondSlash)
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
 * Load the preset layers: every `*.yml`/`*.yaml` document under the given
 * directories (lexical order, so `10-xxx.preset.yml` stacks before
 * `20-yyy.preset.yml`), each with the exact `plugins.yml` document shape —
 * a preset IS a user layer, just not the user's. A missing directory
 * contributes nothing; a broken preset file throws (the caller keeps the
 * previously mounted tree running).
 *
 * Presets sit between the builtin layer and the user layer: a machine-model's
 * factory combination ships as one replaceable file, the user's hand edits
 * ride above it and win per field, and pushing a new preset never overwrites
 * user adjustments.
 *
 * @param dirs - preset directories; missing ones are ignored.
 * @returns the parsed layers, farthest-first.
 */
export function loadPresetLayers(dirs: readonly string[]): UserLayer[] {
  const layers: UserLayer[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
      .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort()
    for (const file of files) layers.push(loadUserLayer(join(dir, file)))
  }
  return layers
}

/**
 * Stack layers right-over-left, per name and per field: the rightmost layer
 * carrying a field wins, a field only an earlier layer carries survives, and
 * a row only earlier layers carry is inserted. `enabled` and `config` are
 * the only fields a row has, so "per field" is the whole story. The caller
 * passes presets farthest-first with the user layer LAST — the user always
 * has the final word.
 *
 * @param layers - the layers to stack; the last one wins.
 * @returns one merged layer addressing the compositor as usual.
 */
export function mergeLayers(layers: readonly UserLayer[]): UserLayer {
  const rows = new Map<string, UserPluginRow>()
  for (const layer of layers) {
    for (const row of layer.plugins) {
      const existing = rows.get(row.name)
      if (existing === undefined) {
        rows.set(row.name, { ...row })
        continue
      }
      if (row.enabled !== undefined) existing.enabled = row.enabled
      if (row.config !== undefined) existing.config = row.config
    }
  }
  return { plugins: [...rows.values()] }
}

/**
 * The preset file name an installed combo lands as. The `recipe-` prefix
 * keeps combo files from ever colliding with the numbered factory presets
 * (`10-xxx.preset.yml`); both live in the same stacked preset directories
 * and both hot-apply on write.
 *
 * @param id - the combo's stable id (`standard-base`, …).
 * @returns the preset file name carrying the combination.
 */
export function recipePresetFileName(id: string): string {
  return `recipe-${id}.yml`
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
  const seen = new Set<string>()
  for (const raw of plugins) {
    if (raw === null || typeof raw !== 'object' || typeof (raw as UserPluginRow).name !== 'string') {
      throw new Error(`user layer: ${path} contains a row without a name`)
    }
    const row = raw as UserPluginRow
    if (seen.has(row.name)) throw new Error(`user layer: ${path} contains duplicate plugin row ${row.name}`)
    seen.add(row.name)
    rows.push(row)
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
 * `reserved` names (the built-in rows) never resolve from the pool: an
 * installed package may share a name with a shipped row only by forging the
 * pool directory by hand — the app tree keeps the entry either way, so a
 * zip can never take a built-in's seat in the composition.
 *
 * @param name - the entry's module specifier from the composed list.
 * @param pool - discovered plugin descriptors.
 * @param appRoot - directory whose dependency tree resolves built-in names.
 * @param reserved - names that skip the pool lookup (the built-in rows).
 * @returns the resolved specifier (a `file://` URL for absolute results).
 * @throws when a bare name resolves in neither the pool nor `appRoot`.
 */
export function resolveModuleSpecifier(
  name: string,
  pool: ReadonlyMap<string, PluginDescriptor>,
  appRoot: string,
  reserved?: ReadonlySet<string>,
): string {
  if (reserved?.has(name) !== true) {
    const fromPool = pool.get(name)
    if (fromPool !== undefined) return fromPool.entryUrl
    // A subpath row over a pool package (`@snap-rail/equipment/rpc`): the
    // release manifest's exports voice names the entry file.
    const packageName = packageNameOf(name)
    const poolPackage = pool.get(packageName)
    if (poolPackage !== undefined && name !== packageName) {
      const file = poolSubpathFile(poolPackage.dir, `./${name.slice(packageName.length + 1)}`)
      if (file !== undefined) return pathToFileURL(file).href
    }
  }
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
 * Compose the final entry list: built-in layer with preset layers and the
 * user layer applied as patches, every module name resolved to a loadable
 * specifier. Presets stack beneath the user rows (`mergeLayers` produces the
 * one patch set the compositor applies), so a preset row and a user row
 * never land as two patches on one entry.
 *
 * Renderer-occupant rows never join the host tree: they are config-only rows
 * served to the renderer through `client-config.list`, so they skip patching
 * and the pool requirement. Two markers take that path — a name in
 * `rendererPackages` (the dev harness's statically bundled occupants) and a
 * pool package declaring `snapRail.clientOnly` (installed frameworks and
 * stations).
 *
 * @param options - built-in entries, user layer, preset layers, plugin pool, app root.
 * @returns the detached, fully resolved entry list for the loader.
 * @throws when a user row names a plugin present nowhere, or a patch lands on
 * an entry the pre-validation did not predict (composition drift).
 */
export function composeEntries(options: {
  builtin: readonly EntryOptions[]
  userLayer: UserLayer
  presetLayers?: readonly UserLayer[]
  pool: ReadonlyMap<string, PluginDescriptor>
  appRoot: string
  rendererPackages?: readonly string[]
}): EntryOptions[] {
  const userLayer = options.presetLayers !== undefined && options.presetLayers.length > 0
    ? mergeLayers([...options.presetLayers, options.userLayer])
    : options.userLayer
  // User rows address plugins by package name; patches land on entry ids
  // (which default to the name but may differ, e.g. equipment-rpc).
  const rendererPackages = new Set(options.rendererPackages ?? [])
  const builtinByName = new Map(options.builtin.map(entry => [entry.name as string, entry]))
  const patches: PatchOptions[] = []
  for (const row of userLayer.plugins) {
    if (rendererPackages.has(row.name)) continue
    const builtin = builtinByName.get(row.name)
    if (builtin !== undefined) {
      const patch: PatchOptions = { id: builtin.id }
      if (row.config !== undefined) patch.config = row.config
      if (row.enabled === false) patch.disabled = true
      if (row.enabled === true) patch.disabled = false
      if (Object.keys(patch).length > 1) patches.push(patch)
      continue
    }
    const poolPackage = options.pool.get(row.name) ?? options.pool.get(packageNameOf(row.name))
    if (poolPackage !== undefined) {
      // Renderer-only packages (frameworks, stations) declare themselves via
      // their manifest; their rows are config-only, exactly like the dev
      // harness's rendererPackages carve-out. Subpath rows over a pool
      // package (`@snap-rail/equipment/rpc`) compose like plain pool rows —
      // resolveModuleSpecifier routes them through the exports voice.
      if (poolPackage.clientOnly === true) continue
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
  // Built-in rows resolve from the app tree even when the pool holds a
  // same-named package: the shipped set keeps its seat, an install can only
  // sit beside it (see resolveModuleSpecifier's reserved carve-out).
  const reserved = new Set(options.builtin.map(entry => entry.name as string))
  return composed.map(entry => ({ ...entry, name: resolveModuleSpecifier(entry.name, options.pool, options.appRoot, reserved) }))
}

/**
 * Resolve a plugin package's declared `snapRail` manifest field. A pool
 * manifest wins for installed packages — except reserved names (the built-in
 * rows), which always read the app tree so a hand-placed pool directory can
 * not restyle a shipped row's identity; the descriptor's recorded fields
 * rebuild the record, so everything the management surfaces need (kind,
 * layer, category, exclusive, framework, requires, clientOnly, client face)
 * is visible for installed packages. Otherwise the package resolves through
 * the app root's dependency tree and its manifest is read directly.
 * Unresolvable or undeclared → `undefined` — the common plugin declares
 * nothing.
 *
 * @param name - a row name (package or subpath entry).
 * @param appRoot - directory whose dependency tree resolves built-in names.
 * @param pool - the scanned plugin pool, if any.
 * @param reserved - package names that never resolve from the pool.
 */
export function packageManifestOf(
  name: string,
  appRoot: string,
  pool: ReadonlyMap<string, PluginDescriptor> = new Map(),
  reserved?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const packageName = packageNameOf(name)
  const descriptor = reserved?.has(packageName) === true ? undefined : pool.get(packageName)
  if (descriptor !== undefined) {
    const manifest: Record<string, unknown> = {}
    if (descriptor.kind !== undefined) manifest.kind = descriptor.kind
    if (descriptor.layer !== undefined) manifest.layer = descriptor.layer
    if (descriptor.title !== undefined) manifest.title = descriptor.title
    if (descriptor.category !== undefined) manifest.category = descriptor.category
    if (descriptor.exclusive !== undefined) manifest.exclusive = descriptor.exclusive
    if (descriptor.requires !== undefined) manifest.requires = descriptor.requires
    if (descriptor.clientOnly === true) manifest.clientOnly = true
    if (descriptor.clientEntry !== undefined || descriptor.clientSeeds !== undefined || descriptor.externalSeeds !== undefined) {
      manifest.client = {
        ...descriptor.clientEntry !== undefined ? { entry: descriptor.clientEntry } : {},
        ...descriptor.clientSeeds !== undefined ? { seeds: descriptor.clientSeeds } : {},
        ...descriptor.externalSeeds !== undefined ? { externalSeeds: descriptor.externalSeeds } : {},
      }
    }
    if (descriptor.engines !== undefined) manifest.engines = descriptor.engines
    return Object.keys(manifest).length > 0 ? manifest : undefined
  }
  try {
    const require = createRequire(join(appRoot, 'package.json'))
    const manifestPath = require.resolve(`${packageName}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { snapRail?: Record<string, unknown> }
    const snapRail = manifest.snapRail
    return typeof snapRail === 'object' && snapRail !== null ? snapRail : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a plugin package's declared `snapRail.kind` — a thin projection of
 * {@link packageManifestOf}.
 */
export function packageKindOf(
  name: string,
  appRoot: string,
  pool: ReadonlyMap<string, PluginDescriptor> = new Map(),
  reserved?: ReadonlySet<string>,
): string | undefined {
  const kind = packageManifestOf(name, appRoot, pool, reserved)?.kind
  return typeof kind === 'string' ? kind : undefined
}
