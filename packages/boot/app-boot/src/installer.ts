/**
 * The plugin installer: the runtime path a plugin zip takes from a file on
 * disk to a mounted pool package — validation, extraction, and removal. The
 * marketplace of the future is just another source of the same zips.
 *
 * Zip layout: one root directory (the package) or the package at the zip
 * root. The manifest must name a legal package name; `snapRail` fields are
 * validated (kind, permissions) but unenforced beyond shape in this phase.
 * Installing over an installed package updates it in place when the zip's
 * version is strictly higher. Uninstalling removes the pool directory and
 * the package's namespaced store database (its data is its own).
 *
 * @module @snap-rail/app-boot/installer
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import type { SnapRailManifest } from './scan.ts'

/** Installer failures, machine-readable for the wire mapping. */
export type InstallErrorKind = 'bad-zip' | 'bad-manifest' | 'conflict' | 'not-installed' | 'io'

/** One installer failure carrying a machine-readable kind. */
export class InstallError extends Error {
  constructor(public readonly kind: InstallErrorKind, message: string) {
    super(`install: ${message}`)
    this.name = 'InstallError'
  }
}

/** The manifest fields the installer reads beyond the npm baseline. */
interface PackageJson {
  name?: unknown
  version?: unknown
  main?: unknown
  snapRail?: {
    kind?: unknown
    permissions?: unknown
    client?: { entry?: unknown } | undefined
  }
}

/** What a successful install reports back. */
export interface InstallResult {
  name: string
  version: string
  /** Absolute directory the package now occupies in the pool. */
  dir: string
  /** Whether this install replaced an existing (strictly older) copy. */
  updated: boolean
}

/** What a pre-install inspection reports: everything the install-time
 * confirmation dialog shows, without touching the pool. */
export interface InspectResult {
  name: string
  version: string
  kind?: string
  permissions: readonly string[]
  /** Whether the package declares a renderer face (`snapRail.client`). */
  hasClient: boolean
}

/**
 * Inspect a plugin zip: read and validate the manifest, report the install
 * surface (identity, kind, permissions, client face) — no extraction, no
 * pool writes. The confirmation dialog's entire content comes from here.
 *
 * @param zipPath - absolute path of the plugin zip on the host.
 * @throws InstallError for the same malformed inputs {@link installPluginFromZip} rejects.
 */
export function inspectPluginZip(zipPath: string): InspectResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(readFileSync(zipPath)))
  } catch {
    throw new InstallError('bad-zip', `cannot read ${zipPath}`)
  }
  const entries = Object.keys(files).filter(name => !name.endsWith('/'))
  if (entries.length === 0) throw new InstallError('bad-zip', 'the archive is empty')
  const roots = new Set(entries.map(name => name.includes('/') ? name.split('/')[0]! : ''))
  const root = roots.size === 1 && !roots.has('') ? [...roots][0]! : ''
  const manifestFile = files[`${root ? `${root}/` : ''}package.json`]
  if (manifestFile === undefined) {
    throw new InstallError('bad-manifest', 'package.json not found at the archive root')
  }
  const manifest = readManifest(manifestFile)
  if (typeof manifest.name !== 'string' || !/^@[a-z0-9-]+\/[a-z0-9-]+$|^[a-z0-9-]+$/.test(manifest.name)) {
    throw new InstallError('bad-manifest', `package name "${String(manifest.name)}" is not a legal package name`)
  }
  const snapRail = validateSnapRail(manifest)
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    ...(snapRail.kind !== undefined ? { kind: snapRail.kind } : {}),
    permissions: snapRail.permissions ?? [],
    hasClient: snapRail.client !== undefined,
  }
}

function readManifest(file: Uint8Array): PackageJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(file))
  } catch {
    throw new InstallError('bad-manifest', 'package.json is not valid JSON')
  }
  return parsed as PackageJson
}

/** Validate the `snapRail` manifest block's shape (present fields only). */
function validateSnapRail(manifest: PackageJson): SnapRailManifest {
  const snap = manifest.snapRail
  if (snap === undefined) return {}
  if (typeof snap !== 'object' || snap === null) {
    throw new InstallError('bad-manifest', 'snapRail must be an object')
  }
  const out: SnapRailManifest = {}
  if (snap.kind !== undefined) {
    if (typeof snap.kind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(snap.kind)) {
      throw new InstallError('bad-manifest', `snapRail.kind "${String(snap.kind)}" is not a kebab-case kind`)
    }
    out.kind = snap.kind
  }
  if (snap.permissions !== undefined) {
    if (!Array.isArray(snap.permissions) || snap.permissions.some(entry => typeof entry !== 'string')) {
      throw new InstallError('bad-manifest', 'snapRail.permissions must be a string array')
    }
    out.permissions = snap.permissions
  }
  if (snap.client !== undefined) {
    if (typeof snap.client !== 'object' || snap.client === null || typeof snap.client.entry !== 'string' || snap.client.entry === '') {
      throw new InstallError('bad-manifest', 'snapRail.client must be { entry: string }')
    }
    out.client = { entry: snap.client.entry }
  }
  return out
}

/**
 * Compare two version strings (semver-ish, no semver dependency): core
 * segments compare numerically (missing or non-numeric = 0), a `-suffix`
 * prerelease orders before its release, and prerelease identifiers compare
 * numerically when both numeric and lexicographically otherwise.
 *
 * @returns negative when `a < b`, positive when `a > b`, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, ...preA] = a.split('-')
  const [coreB, ...preB] = b.split('-')
  const segsA = (coreA ?? '').split('.')
  const segsB = (coreB ?? '').split('.')
  for (let i = 0; i < Math.max(segsA.length, segsB.length); i++) {
    const rawA = segsA[i]
    const rawB = segsB[i]
    const numA = rawA !== undefined && /^\d+$/.test(rawA) ? Number(rawA) : 0
    const numB = rawB !== undefined && /^\d+$/.test(rawB) ? Number(rawB) : 0
    if (numA !== numB) return numA < numB ? -1 : 1
  }
  const isPreA = preA.length > 0
  const isPreB = preB.length > 0
  if (isPreA !== isPreB) return isPreA ? -1 : 1
  if (!isPreA) return 0
  const idsA = preA.join('-').split('.')
  const idsB = preB.join('-').split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const idA = idsA[i]
    const idB = idsB[i]
    if (idA === idB) continue
    if (idA === undefined) return -1
    if (idB === undefined) return 1
    const numA = /^\d+$/.test(idA) ? Number(idA) : null
    const numB = /^\d+$/.test(idB) ? Number(idB) : null
    if (numA !== null && numB !== null && numA !== numB) return numA < numB ? -1 : 1
    if ((numA === null) !== (numB === null)) return numA !== null ? -1 : 1
    return idA < idB ? -1 : 1
  }
  return 0
}

/** The pool directory one package occupies (`/` sanitized to `__`). */
function poolDirOf(poolDir: string, name: string): string {
  return join(poolDir, name.replaceAll('/', '__'))
}

/**
 * Read an installed package's declared version straight from the pool.
 *
 * @returns the manifest version, `'0.0.0'` when the manifest lacks one or is
 * unreadable (a broken install stays updatable — any real version repairs
 * it), or `undefined` when the package is not installed.
 */
export function installedVersionOf(poolDir: string, name: string): string | undefined {
  const manifest = join(poolDirOf(poolDir, name), 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Install a plugin zip into the pool directory. Installing over an existing
 * copy is an update: it is allowed only when the zip's version is strictly
 * higher (equal or lower versions conflict — uninstall first to downgrade),
 * and it never touches the package's namespaced data (that is uninstall's
 * to delete). Extraction lands in a staging directory that is swapped into
 * place, so a failed write leaves the installed version intact.
 *
 * @param zipPath - absolute path of the plugin zip on the host.
 * @param poolDir - the plugin pool directory (`<home>/plugins`).
 * @returns what landed; the caller re-applies the composition afterwards.
 * @throws InstallError for malformed zips/manifests and version conflicts.
 */
export function installPluginFromZip(zipPath: string, poolDir: string): InstallResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(readFileSync(zipPath)))
  } catch {
    throw new InstallError('bad-zip', `cannot read ${zipPath}`)
  }
  // Find the package root: either every entry shares one top directory, or
  // package.json sits at the zip root.
  const entries = Object.keys(files).filter(name => !name.endsWith('/'))
  if (entries.length === 0) throw new InstallError('bad-zip', 'the archive is empty')
  const roots = new Set(entries.map(name => name.includes('/') ? name.split('/')[0]! : ''))
  const root = roots.size === 1 && !roots.has('') ? [...roots][0]! : ''
  const manifestEntry = `${root ? `${root}/` : ''}package.json`
  const manifestFile = files[manifestEntry]
  if (manifestFile === undefined) {
    throw new InstallError('bad-manifest', 'package.json not found at the archive root')
  }
  const manifest = readManifest(manifestFile)
  if (typeof manifest.name !== 'string' || !/^@[a-z0-9-]+\/[a-z0-9-]+$|^[a-z0-9-]+$/.test(manifest.name)) {
    throw new InstallError('bad-manifest', `package name "${String(manifest.name)}" is not a legal package name`)
  }
  validateSnapRail(manifest)

  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  const dir = poolDirOf(poolDir, manifest.name)
  let updated = false
  if (existsSync(dir)) {
    const installed = installedVersionOf(poolDir, manifest.name) ?? '0.0.0'
    if (compareVersions(version, installed) <= 0) {
      throw new InstallError(
        'conflict',
        `${manifest.name} v${installed} is already installed and the zip carries v${version} — ` +
        'only a strictly higher version updates in place (uninstall first to downgrade)',
      )
    }
    updated = true
  }

  const staging = `${dir}.update-${randomUUID()}`
  try {
    mkdirSync(staging, { recursive: true })
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue
      const relative = root === '' ? name : name.slice(root.length + 1)
      if (relative === '') continue
      const target = join(staging, relative)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, data)
    }
    if (updated) rmSync(dir, { recursive: true, force: true })
    renameSync(staging, dir)
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    if (cause instanceof InstallError) throw cause
    throw new InstallError('io', `cannot write ${manifest.name} into the pool: ${
      cause instanceof Error ? cause.message : String(cause)
    }`)
  }
  return { name: manifest.name, version, dir, updated }
}

/** The store database file a package owns (namespace = sanitized name). */
export function pluginDataFile(home: string, name: string): string {
  const namespace = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')
  return join(home, 'data', `${namespace}.db`)
}

/**
 * Remove a pool package and its data: the pool directory first (its fiber
 * unmounts on the next apply), then the namespaced store database. Unknown
 * names fail loud — never a silent nothing-happened.
 *
 * @param name - the plugin package name.
 * @param poolDir - the plugin pool directory.
 * @param home - the snap-rail home (owns `data/`).
 */
export function uninstallPlugin(name: string, poolDir: string, home: string): void {
  const dir = poolDirOf(poolDir, name)
  if (!existsSync(dir)) {
    throw new InstallError('not-installed', `${name} is not installed`)
  }
  rmSync(dir, { recursive: true, force: true })
  const data = pluginDataFile(home, name)
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${data}${suffix}`
    if (existsSync(file)) rmSync(file, { force: true })
  }
}
