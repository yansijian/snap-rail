/**
 * The plugin installer: the runtime path a plugin zip takes from a file on
 * disk to a mounted pool package — validation, extraction, and removal. The
 * marketplace of the future is just another source of the same zips.
 *
 * Zip layout: one root directory (the package) or the package at the zip
 * root. The manifest must name a legal package name; `snapRail` fields,
 * capabilities and runtime engine ranges are validated before extraction.
 * Installing over an installed package updates it in place when the zip's
 * version is strictly higher. Uninstalling removes the pool directory and
 * the package's namespaced store database (its data is its own).
 *
 * @module @snap-rail/app-boot/installer
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { verifyReleaseFiles, type TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'
import { snapRailManifestSchema } from '@snap-rail/plugin-kit/manifest'
import type { SnapRailManifest } from './scan.ts'

/** Installer failures, machine-readable for the wire mapping. */
export type InstallErrorKind = 'bad-zip' | 'bad-manifest' | 'bad-signature' | 'conflict' | 'not-installed' | 'io'

/** Engine versions implemented by this Host/Renderer release. */
export const HOST_ENGINE_VERSIONS = {
  snapRail: '0.1.0',
  hostProtocol: '1.0.0',
  renderer: '1.0.0',
} as const

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
  snapRail?: unknown
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
  title?: string
  category?: string
  permissions: readonly string[]
  /** Whether the package declares a renderer face (`snapRail.client`). */
  hasClient: boolean
  /** Declared dependencies (`snapRail.requires`), unfiltered. */
  requires: readonly string[]
  capabilities?: { provides?: readonly { id: string, version: string }[], requires?: readonly { id: string, range: string, optional?: boolean }[] }
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** The release signature key id when the archive carries signed metadata. */
  signatureKeyId?: string
}

/**
 * Inspect a plugin zip: read and validate the manifest, report the install
 * surface (identity, kind, permissions, client face) — no extraction, no
 * pool writes. The confirmation dialog's entire content comes from here.
 *
 * @param zipPath - absolute path of the plugin zip on the host.
 * @throws InstallError for the same malformed inputs {@link installPluginFromZip} rejects.
 */
export function inspectPluginZip(zipPath: string, options?: { trustedKeys?: readonly TrustedReleaseKey[] }): InspectResult {
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
  validateArchivePaths(entries, root)
  const manifestFile = files[`${root ? `${root}/` : ''}package.json`]
  if (manifestFile === undefined) {
    throw new InstallError('bad-manifest', 'package.json not found at the archive root')
  }
  const manifest = readManifest(manifestFile)
  if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) {
    throw new InstallError('bad-manifest', `package name "${String(manifest.name)}" is not a legal package name`)
  }
  const snapRail = validateSnapRail(manifest)
  const signatureKeyId = verifyArchiveSignature(files, root, options?.trustedKeys, manifest.name, typeof manifest.version === 'string' ? manifest.version : '0.0.0')
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    ...(snapRail.kind !== undefined ? { kind: snapRail.kind } : {}),
    ...(snapRail.title !== undefined ? { title: snapRail.title } : {}),
    ...(snapRail.category !== undefined ? { category: snapRail.category } : {}),
    permissions: snapRail.permissions ?? [],
    hasClient: snapRail.client !== undefined,
    requires: snapRail.requires ?? [],
    ...(snapRail.capabilities === undefined ? {} : { capabilities: snapRail.capabilities }),
    ...(snapRail.engines === undefined ? {} : { engines: snapRail.engines }),
    ...(signatureKeyId === undefined ? {} : { signatureKeyId }),
  }
}

/** Verify a release envelope when the caller supplies a trust store. */
function verifyArchiveSignature(
  files: Record<string, Uint8Array>,
  root: string,
  trustedKeys: readonly TrustedReleaseKey[] | undefined,
  expectedName?: string,
  expectedVersion?: string,
): string | undefined {
  const prefix = root === '' ? '' : `${root}/`
  const metadata = files[`${prefix}META-INF/release.json`]
  const signature = files[`${prefix}META-INF/signature.json`]
  if (trustedKeys === undefined) return signature === undefined ? undefined : readSignatureKeyId(signature)
  if (metadata === undefined || signature === undefined) throw new InstallError('bad-signature', 'signed release metadata is missing')
  const normalized: Record<string, Uint8Array> = {}
  for (const [path, data] of Object.entries(files)) {
    const relative = root === '' ? path : path.startsWith(prefix) ? path.slice(prefix.length) : path
    normalized[relative] = data
  }
  try {
    const verified = verifyReleaseFiles(normalized, trustedKeys)
    if ((expectedName !== undefined && verified.name !== expectedName) || (expectedVersion !== undefined && verified.version !== expectedVersion)) {
      throw new Error('release metadata identity does not match package.json')
    }
    const parsed = JSON.parse(new TextDecoder().decode(signature)) as { keyId?: unknown }
    return typeof parsed.keyId === 'string' ? parsed.keyId : verified.name
  } catch (cause) {
    throw new InstallError('bad-signature', cause instanceof Error ? cause.message : String(cause))
  }
}

function readSignatureKeyId(file: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file)) as { keyId?: unknown }
    return typeof parsed.keyId === 'string' ? parsed.keyId : undefined
  } catch {
    return undefined
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

/** Reject zip entries that could escape the staging directory on extraction. */
function validateArchivePaths(entries: readonly string[], root: string): void {
  const prefix = root === '' ? '' : `${root}/`
  for (const entry of entries) {
    const relative = root === '' ? entry : entry.startsWith(prefix) ? entry.slice(prefix.length) : entry
    const normalized = relative.replaceAll('\\', '/')
    if (normalized === '' || normalized.includes('\0') || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new InstallError('bad-zip', `archive entry escapes its package root: ${entry}`)
    }
  }
}

/** Validate the `snapRail` manifest with the public SDK schema and check the
 * installed Host/Renderer engine ranges. The installer and authors therefore
 * share one strict manifest contract. */
function validateSnapRail(manifest: PackageJson): SnapRailManifest {
  let parsed: SnapRailManifest
  try {
    parsed = snapRailManifestSchema.parse(manifest.snapRail ?? {}) as SnapRailManifest
  } catch (cause) {
    throw new InstallError('bad-manifest', `snapRail manifest 无效：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  for (const [key, range] of Object.entries(parsed.engines ?? {})) {
    const actual = HOST_ENGINE_VERSIONS[key as keyof typeof HOST_ENGINE_VERSIONS]
    if (actual !== undefined && !satisfiesRuntimeRange(actual, range)) {
      throw new InstallError('bad-manifest', `插件要求 ${key} ${range}，当前版本为 ${actual}`)
    }
  }
  return parsed
}

function satisfiesRuntimeRange(version: string, range: string): boolean {
  const actual = parseRuntimeVersion(version)
  const trimmed = range.trim()
  const target = parseRuntimeVersion(trimmed.replace(/^(\^|~|>=|>|<=|<|=)\s*/, ''))
  if (target === undefined || actual === undefined) return false
  if (trimmed.startsWith('^')) return actual[0] === target[0] && compareRuntimeTuple(actual, target) >= 0
  if (trimmed.startsWith('~')) return actual[0] === target[0] && actual[1] === target[1] && compareRuntimeTuple(actual, target) >= 0
  if (trimmed.startsWith('>=')) return compareRuntimeTuple(actual, target) >= 0
  if (trimmed.startsWith('>')) return compareRuntimeTuple(actual, target) > 0
  if (trimmed.startsWith('<=')) return compareRuntimeTuple(actual, target) <= 0
  if (trimmed.startsWith('<')) return compareRuntimeTuple(actual, target) < 0
  return compareRuntimeTuple(actual, target) === 0
}

function parseRuntimeVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareRuntimeTuple(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
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
 * @param options - `reserved`: names an install must never take (the
 *   built-in rows and their packages). A zip claiming one is refused before
 *   any byte lands — an installed package can sit beside the shipped set,
 *   never on top of it.
 * @returns what landed; the caller re-applies the composition afterwards.
 * @throws InstallError for malformed zips/manifests and name/version conflicts.
 */
export function installPluginFromZip(zipPath: string, poolDir: string, options?: {
  reserved?: readonly string[]
  trustedKeys?: readonly TrustedReleaseKey[]
}): InstallResult {
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
  validateArchivePaths(entries, root)
  const manifestEntry = `${root ? `${root}/` : ''}package.json`
  const manifestFile = files[manifestEntry]
  if (manifestFile === undefined) {
    throw new InstallError('bad-manifest', 'package.json not found at the archive root')
  }
  const manifest = readManifest(manifestFile)
  if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) {
    throw new InstallError('bad-manifest', `package name "${String(manifest.name)}" is not a legal package name`)
  }
  validateSnapRail(manifest)
  verifyArchiveSignature(files, root, options?.trustedKeys, manifest.name, typeof manifest.version === 'string' ? manifest.version : '0.0.0')
  if (options?.reserved?.includes(manifest.name) === true) {
    throw new InstallError('conflict', `${manifest.name} is a built-in package name (an install cannot replace built-ins)`)
  }

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
  const backup = updated ? `${dir}.backup-${randomUUID()}` : undefined
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
    if (backup !== undefined) renameSync(dir, backup)
    renameSync(staging, dir)
    if (backup !== undefined) rmSync(backup, { recursive: true, force: true })
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    if (backup !== undefined && existsSync(backup)) {
      rmSync(dir, { recursive: true, force: true })
      renameSync(backup, dir)
    }
    if (cause instanceof InstallError) throw cause
    throw new InstallError('io', `cannot write ${manifest.name} into the pool: ${
      cause instanceof Error ? cause.message : String(cause)
    }`)
  }
  return { name: manifest.name, version, dir, updated }
}

/**
 * Run several pool installs as one filesystem transaction. Existing package
 * directories are copied to a private sibling backup before the callback runs;
 * the live copy stays visible so each normal install still enforces its
 * strictly-higher version rule. Any callback failure removes newly landed
 * directories and restores every backup. The caller owns the composition
 * refresh after rollback.
 */
export async function withPluginPoolTransaction<T>(
  poolDir: string,
  names: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  mkdirSync(poolDir, { recursive: true })
  const transaction = join(poolDir, `.transaction-${randomUUID()}`)
  mkdirSync(transaction, { recursive: true })
  const uniqueNames = [...new Set(names)]
  const backups: Array<{ name: string, dir: string }> = []
  let runStarted = false
  try {
    for (const name of uniqueNames) {
      const dir = poolDirOf(poolDir, name)
      if (!existsSync(dir)) continue
      const backup = join(transaction, name.replaceAll('/', '__'))
      cpSync(dir, backup, { recursive: true })
      backups.push({ name, dir: backup })
    }
    runStarted = true
    const result = await run()
    rmSync(transaction, { recursive: true, force: true })
    return result
  } catch (cause) {
    // A backup failure happened before the callback could mutate the live
    // pool. Leave every original directory untouched; deleting it here would
    // turn a failed copy into data loss.
    if (!runStarted) {
      rmSync(transaction, { recursive: true, force: true })
      throw cause
    }
    for (const name of uniqueNames) {
      rmSync(poolDirOf(poolDir, name), { recursive: true, force: true })
    }
    for (const backup of backups.reverse()) {
      cpSync(backup.dir, poolDirOf(poolDir, backup.name), { recursive: true })
    }
    rmSync(transaction, { recursive: true, force: true })
    throw cause
  }
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
