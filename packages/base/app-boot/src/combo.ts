/**
 * Offline combo archives: a plain zip carrying `recipe.yml` at the root plus
 * one signed plugin zip per referenced package under `plugins/`. The combo
 * is a distribution convenience, not a new trust boundary — it has no
 * signature of its own; every member zip keeps its release signature and
 * faces the same installer gates (trust policy, seed ABI, reserved names).
 * Inspecting the archive reports the members and how each would land;
 * installing it is the rpc bridge's transaction (pool + preset together).
 *
 * @module @snap-rail/app-boot/combo
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { load } from 'js-yaml'
import { satisfiesRange, splitNameRange } from '@snap-rail/util/semver'
import {
  recipeDocumentSchema,
  recipePackageNames,
  type RecipeDocument,
} from '@snap-rail/plugin-kit/recipe'
import type { TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'
import type { SignaturePolicy } from './installer.ts'
import {
  compareVersions,
  InstallError,
  inspectPluginZip,
  type InspectResult,
} from './installer.ts'
import type {
  InspectedCombo,
  InspectedComboPlugin,
  RemoteAction,
} from './contract.ts'

/** The compressed archive ceiling (the direct-download ceiling, shared). */
const COMBO_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024
/** The members' total uncompressed ceiling: a whole scenario must stay
 * bounded even when each member zip is individually reasonable. */
const COMBO_MEMBERS_MAX_BYTES = 512 * 1024 * 1024

/** One plugin zip extracted from a combo archive. */
export interface ComboMember {
  /** Package name from the member zip's own manifest. */
  name: string
  /** The temp file the member was extracted to (inside {@link ComboArchive.dir}). */
  zipPath: string
  /** The member's own inspection (identity, signature, requires, client face). */
  inspection: InspectResult
}

/** One validated combo archive with its members extracted to a temp dir. */
export interface ComboArchive {
  /** The parsed `recipe.yml` document. */
  recipe: RecipeDocument
  /** Members in the recipe's row order (one per unique package). */
  members: readonly ComboMember[]
  /** Optional `readme.md` at the archive root. */
  readme?: string
  /** The temp directory holding the member zips — the caller removes it. */
  dir: string
}

/** How a combo inspection resolves the local home's existing state. */
export interface ComboInspectOptions {
  trustedKeys?: readonly TrustedReleaseKey[]
  signaturePolicy?: SignaturePolicy
  /** The installed version of a package (pool, built-in, or app tree), or
   * `undefined` when the home does not have it. */
  installedVersionOf?: (name: string) => string | undefined
  /** Whether an installed-but-unversioned package (a shipped row) exists. */
  shipped?: (name: string) => boolean
}

/** A combo preview plus its extracted archive (the install path reuses the
 * member zips; the caller removes `archive.dir` when done). */
export interface ComboInspection {
  combo: InspectedCombo
  archive: ComboArchive
}

/** The zip's package root: one shared top directory, or the archive root. */
function archiveRoot(entries: readonly string[]): string {
  const roots = new Set(entries.map(name => name.includes('/') ? name.split('/')[0]! : ''))
  return roots.size === 1 && !roots.has('') ? [...roots][0]! : ''
}

/** Reject zip entries that could escape an extraction directory. */
function validateArchivePaths(entries: readonly string[], root: string): void {
  const prefix = root === '' ? '' : `${root}/`
  for (const entry of entries) {
    const relative = root === '' ? entry : entry.startsWith(prefix) ? entry.slice(prefix.length) : entry
    const normalized = relative.replaceAll('\\', '/')
    if (normalized === '' || normalized.includes('\0') || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new InstallError('bad-combo', `压缩包条目越出组合根目录：${entry}`)
    }
  }
}

/** Read + unzip one archive, mapping unreadable bytes onto the install error
 * surface. */
function readArchive(zipPath: string): { files: Record<string, Uint8Array>, entries: readonly string[], root: string } {
  let size: number
  try {
    size = statSync(zipPath).size
  } catch {
    throw new InstallError('bad-zip', `无法读取 ${zipPath}`)
  }
  if (size > COMBO_ARCHIVE_MAX_BYTES) {
    throw new InstallError('bad-combo', `组合包超过大小上限（${size} 字节 > ${COMBO_ARCHIVE_MAX_BYTES}）`)
  }
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(readFileSync(zipPath)))
  } catch {
    throw new InstallError('bad-zip', `无法读取 ${zipPath}`)
  }
  const entries = Object.keys(files).filter(name => !name.endsWith('/'))
  if (entries.length === 0) throw new InstallError('bad-zip', '压缩包是空的')
  const root = archiveRoot(entries)
  validateArchivePaths(entries, root)
  return { files, entries, root }
}

/**
 * What kind of archive the bytes are: the root marker decides, not the URL
 * or the file name. A plugin carries `package.json`; a combo carries
 * `recipe.yml`; carrying both is ambiguous and refused.
 *
 * @param zipPath - absolute path of the archive.
 * @returns `'plugin'` or `'combo'`.
 * @throws InstallError for unreadable/empty archives and ambiguous roots.
 */
export function archiveKind(zipPath: string): 'plugin' | 'combo' {
  const { files, root } = readArchive(zipPath)
  const prefix = root === '' ? '' : `${root}/`
  const hasRecipe = files[`${prefix}recipe.yml`] !== undefined || files[`${prefix}recipe.yaml`] !== undefined
  const hasPackage = files[`${prefix}package.json`] !== undefined
  if (hasRecipe && hasPackage) {
    throw new InstallError('bad-combo', '压缩包根目录同时含 package.json 与 recipe.yml，无法判定是插件包还是组合包')
  }
  if (hasRecipe) return 'combo'
  if (hasPackage) return 'plugin'
  throw new InstallError('bad-combo', '不是插件包或组合包：根目录缺少 package.json / recipe.yml')
}

/** Parse the recipe document: strict — a combo lands a preset, so any field
 * the compositor does not speak is refused up front. */
function parseRecipe(text: string): RecipeDocument {
  let parsed: unknown
  try {
    parsed = load(text)
  } catch {
    throw new InstallError('bad-combo', 'recipe.yml 不是合法 YAML')
  }
  const document = recipeDocumentSchema.safeParse(parsed)
  if (!document.success) {
    const issue = document.error.issues[0]
    throw new InstallError(
      'bad-combo',
      `recipe.yml 不合法（${issue?.path.join('.') ?? 'recipe'}: ${issue?.message ?? 'unknown'}）`,
    )
  }
  return document.data
}

/**
 * Read one combo archive: validate its layout, parse `recipe.yml`, extract
 * every `plugins/*.zip` to a temp directory and inspect it. The archive must
 * carry exactly one zip per package the recipe references — a subpath row
 * (`@snap-rail/equipment/rpc`) addresses its package
 * (`@snap-rail/equipment`), and missing or extra zips are refused (a silent
 * half-combo would fail at the next boot, not here).
 *
 * @param zipPath - absolute path of the combo zip.
 * @param options - trust store and signature policy for member inspection.
 * @returns the parsed document and extracted members (caller removes `dir`).
 * @throws InstallError for malformed layout, bad members, or name mismatches.
 */
export function readComboArchive(zipPath: string, options: ComboInspectOptions = {}): ComboArchive {
  const { files, entries, root } = readArchive(zipPath)
  const prefix = root === '' ? '' : `${root}/`
  if (files[`${prefix}package.json`] !== undefined) {
    throw new InstallError('bad-combo', '这是插件包（根目录含 package.json），不是组合包')
  }
  const recipeFile = files[`${prefix}recipe.yml`] ?? files[`${prefix}recipe.yaml`]
  if (recipeFile === undefined) {
    throw new InstallError('bad-combo', '组合包根目录缺少 recipe.yml')
  }
  const readmeFile = files[`${prefix}readme.md`] ?? files[`${prefix}README.md`]
  const recipe = parseRecipe(new TextDecoder().decode(recipeFile))

  const members: Array<{ file: string, bytes: Uint8Array }> = []
  const allowedRoot = new Set([`${prefix}recipe.yml`, `${prefix}recipe.yaml`, `${prefix}readme.md`, `${prefix}README.md`])
  for (const entry of entries) {
    if (allowedRoot.has(entry)) continue
    const relative = entry.slice(prefix.length)
    const match = /^plugins\/([^/]+\.zip)$/.exec(relative)
    if (match === null) {
      throw new InstallError('bad-combo', `组合包只能包含 recipe.yml、readme.md 与 plugins/*.zip（多出 ${relative}）`)
    }
    members.push({ file: match[1]!, bytes: files[entry]! })
  }
  if (members.length === 0) {
    throw new InstallError('bad-combo', '组合包的 plugins/ 下没有任何插件 zip')
  }

  const referenced = recipePackageNames(recipe)
  const referencedSet = new Set(referenced)
  const dir = mkdtempSync(join(tmpdir(), 'snap-rail-combo-'))
  try {
    const inspected: ComboMember[] = []
    let total = 0
    for (const [index, member] of members.entries()) {
      total += member.bytes.byteLength
      if (total > COMBO_MEMBERS_MAX_BYTES) {
        throw new InstallError('bad-combo', `组合包内插件总大小超过上限（> ${COMBO_MEMBERS_MAX_BYTES} 字节）`)
      }
      const memberPath = join(dir, `member-${index}.zip`)
      writeFileSync(memberPath, member.bytes)
      const inspection = inspectPluginZip(memberPath, {
        ...(options.trustedKeys !== undefined ? { trustedKeys: options.trustedKeys } : {}),
        ...(options.signaturePolicy !== undefined ? { signaturePolicy: options.signaturePolicy } : {}),
      })
      if (!referencedSet.has(inspection.name)) {
        throw new InstallError('bad-combo', `组合包含未在 recipe.yml 引用的插件 ${inspection.name}`)
      }
      if (inspected.some(existing => existing.name === inspection.name)) {
        throw new InstallError('bad-combo', `组合包含重复插件 ${inspection.name}`)
      }
      inspected.push({ name: inspection.name, zipPath: memberPath, inspection })
    }
    const missing = referenced.filter(name => !inspected.some(member => member.name === name))
    if (missing.length > 0) {
      throw new InstallError(
        'bad-combo',
        `组合引用的插件缺少 zip：${missing.join('、')}（plugins/ 下每个引用包一个 zip）`,
      )
    }
    const ordered = referenced.map(name => inspected.find(member => member.name === name)!)
    return {
      recipe,
      members: ordered,
      ...(readmeFile !== undefined ? { readme: new TextDecoder().decode(readmeFile) } : {}),
      dir,
    }
  } catch (cause) {
    rmSync(dir, { recursive: true, force: true })
    throw cause
  }
}

/**
 * Inspect a combo archive and annotate its members against the local home:
 * each member's landing action, the aggregate unsatisfied requirements, and
 * whether any member carries a renderer face. No pool or preset writes; the
 * returned archive's temp directory is the caller's to remove.
 *
 * @param zipPath - absolute path of the combo zip.
 * @param options - trust store, signature policy, and installed-state probes.
 * @returns the combo preview plus the extracted archive.
 * @throws InstallError for malformed archives or member zips.
 */
export function inspectComboZip(zipPath: string, options: ComboInspectOptions = {}): ComboInspection {
  const archive = readComboArchive(zipPath, options)
  const versions = new Map(archive.members.map(member => [member.name, member.inspection.version]))
  const versionOf = (name: string): string | undefined =>
    versions.get(name) ?? options.installedVersionOf?.(name)
  const present = (name: string): boolean =>
    versionOf(name) !== undefined || options.shipped?.(name) === true

  const missing: string[] = []
  const remember = (entry: string): void => {
    if (!missing.includes(entry)) missing.push(entry)
  }
  for (const member of archive.members) {
    for (const entry of member.inspection.requires) {
      // Service requirements are runtime facts, not install-time ones.
      if (entry.startsWith('service:')) continue
      const { name, range } = splitNameRange(entry)
      if (!present(name)) {
        remember(entry)
        continue
      }
      const version = versionOf(name)
      if (range !== undefined && version !== undefined && !satisfiesRange(version, range)) remember(entry)
    }
    for (const seed of member.inspection.externalSeeds) {
      const provider = seed.split('/').slice(0, seed.startsWith('@') ? 2 : 1).join('/')
      if (!present(provider)) remember(`${seed}（提供方未安装）`)
    }
  }

  const plugins: InspectedComboPlugin[] = archive.members.map(member => {
    const installedVersion = options.installedVersionOf?.(member.name)
    let action: RemoteAction = 'install'
    if (installedVersion !== undefined) {
      const order = compareVersions(member.inspection.version, installedVersion)
      action = order > 0 ? 'update' : order === 0 ? 'current' : 'local-newer'
    }
    return {
      name: member.inspection.name,
      version: member.inspection.version,
      ...(member.inspection.kind !== undefined ? { kind: member.inspection.kind } : {}),
      ...(member.inspection.title !== undefined ? { title: member.inspection.title } : {}),
      ...(member.inspection.category !== undefined ? { category: member.inspection.category } : {}),
      permissions: member.inspection.permissions,
      hasClient: member.inspection.hasClient,
      signature: member.inspection.signature,
      ...(installedVersion !== undefined ? { installed: { version: installedVersion } } : {}),
      action,
    }
  })

  return {
    combo: {
      id: archive.recipe.id,
      version: archive.recipe.version,
      title: archive.recipe.title,
      kind: archive.recipe.kind,
      ...(archive.recipe.description !== undefined ? { description: archive.recipe.description } : {}),
      plugins,
      missing,
      hasClient: archive.members.some(member => member.inspection.hasClient),
    },
    archive,
  }
}
