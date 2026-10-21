/**
 * Final-format assembly: turn a built plugin package into the file set of
 * its installable zip. The zip is **the release artifact, not the source
 * tree** — a trimmed manifest whose `main` names the host face (or, for
 * `clientOnly` packages, the client bundle), the built faces themselves, and
 * an `exports` map covering the subpaths pool-resident importers resolve
 * (`./contract` and friends). The settings page's 安装插件, the CLI packer,
 * the feed publishers, and the offline combo assembler all consume the same
 * shape.
 *
 * @module @snap-rail/plugin-kit/pack
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { unzipSync } from 'fflate'
import { CLIENT_EXTERNALS, SEED_ABI_REVISION, type SeedAbi } from './seeds.ts'
import { clientSurfacesSchema } from './manifest.ts'
import type { ReleaseSignature } from './sign.ts'

/** The manifest fields the release manifest carries over from the source. */
interface SourceManifest {
  name?: unknown
  version?: unknown
  description?: unknown
  snapRail?: {
    clientOnly?: unknown
    client?: { entry?: unknown, surfaces?: unknown } | undefined
  } & Record<string, unknown>
}

/** What one plugin package ships: its host face directory and (optionally)
 * the built client bundle directory (the bundle plus emitted assets). */
export interface ReleaseSpec {
  /** The package's npm name; must match the source manifest. */
  name: string
  /** Absolute package directory (the workspace package at pack time). */
  dir: string
  /** Directory inside the package holding the built host face — included
   * wholesale (multi-entry builds emit shared chunks beside the entries).
   * Declarations, source maps, and tsbuildinfo files never ship. Required
   * with `hostFace`. */
  hostDir?: string | undefined
  /** Path inside the package of the host face entry — becomes the manifest
   * `main` (the pool mounts exactly one host entry per package). Omitted for
   * `snapRail.clientOnly` packages (renderer-only; `main` names the client
   * bundle instead). */
  hostFace?: string | undefined
  /** Directory inside the package holding the built client bundle and its
   * assets; required iff the manifest declares `snapRail.client`. */
  clientFace?: string | undefined
  /** Extra subpath exports the release manifest carries beyond `.` (e.g.
   * `'./contract' → 'lib/contract.js'`), so pool-resident importers and the
   * resolve-hooks pool fallback can bind them. Targets must ship. */
  exports?: Readonly<Record<string, string>> | undefined
}

/** Files a release never carries even inside a face directory. */
function isBuildPlumbing(path: string): boolean {
  return path.endsWith('.d.ts') || path.endsWith('.d.ts.map') || path.endsWith('.js.map')
    || path.endsWith('.tsbuildinfo')
}

/**
 * Derive the release manifest: the npm identity plus `main` plus the trimmed
 * `exports` map. Everything else (scripts, dev dependencies) is workspace
 * plumbing the pool never reads and the zip never carries. A stamped seed
 * ABI merges into `snapRail.client` — the build-truth declaration replaces
 * anything a source manifest may have carried.
 *
 * @param source - the parsed source `package.json`.
 * @param main - the entry the manifest `main` names.
 * @param exports - subpath exports beyond `.`; the root voice is always
 *   included.
 * @param seedAbi - the pack-time seed-contract stamp for client faces.
 * @returns the manifest serialized for the zip root.
 */
export function releaseManifest(
  source: SourceManifest,
  main: string,
  exports?: Readonly<Record<string, string>>,
  seedAbi?: SeedAbi | undefined,
): string {
  const snapRail = source.snapRail
  const manifest: Record<string, unknown> = {
    name: source.name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    description: typeof source.description === 'string' ? source.description : '',
    type: 'module',
    main,
    exports: { '.': main, ...exports },
  }
  if (snapRail !== undefined) {
    manifest.snapRail = seedAbi === undefined
      ? snapRail
      : {
          ...snapRail,
          client: { ...snapRail.client, seedAbi },
        }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** The base npm package of a seed id (`react/jsx-runtime` → `react`;
 * `@scope/name/sub` → `@scope/name`). */
function basePackageOf(seedId: string): string {
  const parts = seedId.split('/')
  return seedId.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/**
 * Stamp the seed ABI a set of built client faces were built against: the
 * seeds their bundles actually require (a `require("…")` literal scan —
 * externals are the only bare requires the welded CJS output carries) plus
 * each seed's base-package version resolved from the package's own dependency
 * tree. A multi-surface package stamps ONE declaration for all its entries
 * (the union of their requires): every surface shares the shell's seed table,
 * so a per-face stamp would only repeat the same verdict N times. Ids whose
 * base package cannot be resolved here are omitted — the runtime check
 * compares only the intersection, so an omitted id is unchecked, never
 * failed. Returns `undefined` when the bundles require no seeds or none could
 * be versioned (nothing to enforce).
 *
 * @param packageDir - the package being packed (version resolution root).
 * @param bundleCodes - the built client bundles' source texts, one per surface.
 */
async function seedAbiStamp(packageDir: string, bundleCodes: readonly string[]): Promise<SeedAbi | undefined> {
  const seeds = new Set(CLIENT_EXTERNALS)
  const required = new Set<string>()
  for (const bundleCode of bundleCodes) {
    for (const match of bundleCode.matchAll(/require\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
      const id = match[2]
      if (id !== undefined && seeds.has(id)) required.add(id)
    }
  }
  if (required.size === 0) return undefined
  const require = createRequire(join(packageDir, 'package.json'))
  const versions: Record<string, string> = {}
  for (const id of required) {
    try {
      const manifestPath = require.resolve(`${basePackageOf(id)}/package.json`)
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') versions[id] = parsed.version
    } catch {
      // Not resolvable from this package (not a declared dependency) —
      // declare nothing; the boot check compares only what is declared.
    }
  }
  if (Object.keys(versions).length === 0) return undefined
  return { revision: SEED_ABI_REVISION, versions }
}

/** Collect every file under `dir` (zip paths use forward slashes). */
async function collectDir(dir: string, base: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, await collectDir(full, base))
      continue
    }
    const rel = relative(base, full).replaceAll('\\', '/')
    if (isBuildPlumbing(rel)) continue
    files[rel] = new Uint8Array(await readFile(full))
  }
  return files
}

/**
 * Assemble one package's release file set: the release manifest, the declared
 * faces, and the exports targets. Fails loud when the source manifest drifts
 * from the spec or a declared face is missing on disk, so a broken build can
 * never ship as a plausible zip.
 *
 * @param spec - what the package ships and from where.
 * @returns the zip's files, keyed by package-relative path.
 */
export async function releaseFiles(spec: ReleaseSpec): Promise<Record<string, Uint8Array>> {
  let source: SourceManifest
  try {
    source = JSON.parse(await readFile(join(spec.dir, 'package.json'), 'utf8')) as SourceManifest
  } catch (cause) {
    throw new Error(`pack: cannot read the manifest of ${spec.name}`, { cause })
  }
  if (source.name !== spec.name) {
    throw new Error(`pack: manifest name ${String(source.name)} does not match the spec ${spec.name}`)
  }
  const snapRail = source.snapRail
  const declaredClient = snapRail?.client !== undefined
  if (declaredClient !== (spec.clientFace !== undefined)) {
    throw new Error(`pack: ${spec.name} declares snapRail.client ${declaredClient ? 'with' : 'without'} a clientFace directory`)
  }

  const clientOnly = snapRail?.clientOnly === true
  if (spec.hostFace === undefined && !clientOnly) {
    throw new Error(`pack: ${spec.name} has no host face and does not declare snapRail.clientOnly`)
  }
  if (spec.hostFace !== undefined && spec.hostDir === undefined) {
    throw new Error(`pack: ${spec.name} declares a host face without a hostDir`)
  }
  if (spec.hostFace === undefined && spec.clientFace === undefined) {
    throw new Error(`pack: ${spec.name} ships neither a host face nor a client bundle`)
  }
  const clientEntry = typeof snapRail?.client?.entry === 'string' ? snapRail.client.entry : 'lib/client.js'
  // Auxiliary surfaces are validated here rather than trusted: a typo'd key
  // (`mian`) or a `main` override would silently ship a bundle no surface
  // ever loads, and the installer's schema would accept it too.
  let clientSurfaces: Readonly<Partial<Record<string, string>>> = {}
  if (snapRail?.client?.surfaces !== undefined) {
    const parsed = clientSurfacesSchema.safeParse(snapRail.client.surfaces)
    if (!parsed.success) {
      throw new Error(`pack: ${spec.name} declares an invalid snapRail.client.surfaces (${parsed.error.issues.map(issue => issue.message).join('; ')})`)
    }
    clientSurfaces = parsed.data
  }
  const main = spec.hostFace ?? clientEntry

  const files: Record<string, Uint8Array> = {}
  if (spec.hostDir !== undefined) {
    Object.assign(files, await collectDir(join(spec.dir, spec.hostDir), spec.dir))
    // The tsc staging tree (`<hostDir>/types` — type-stripped intermediates the
    // two-stage build emits beside the faces, stale files included) is build
    // plumbing like declarations and maps; it never ships.
    for (const path of Object.keys(files)) {
      if (path === `${spec.hostDir}/types` || path.startsWith(`${spec.hostDir}/types/`)) delete files[path]
    }
  }
  if (spec.clientFace !== undefined) {
    Object.assign(files, await collectDir(join(spec.dir, spec.clientFace), spec.dir))
  }
  if (spec.hostFace !== undefined && files[spec.hostFace] === undefined) {
    throw new Error(`pack: ${spec.name} is missing its host face ${spec.hostFace} under ${String(spec.hostDir)}`)
  }
  if (declaredClient && files[clientEntry] === undefined) {
    throw new Error(`pack: ${spec.name} declares client entry ${clientEntry} but the zip does not carry it`)
  }
  for (const [surface, entry] of Object.entries(clientSurfaces)) {
    if (entry === undefined) continue
    if (files[entry] === undefined) {
      throw new Error(`pack: ${spec.name} declares the ${surface} surface entry ${entry} but the zip does not carry it`)
    }
    if (entry === clientEntry) {
      throw new Error(`pack: ${spec.name} points the ${surface} surface at the main client entry ${entry} — each surface needs its own bundle`)
    }
  }
  // The manifest lands last: a client face's seed ABI is stamped from the
  // built bundles it ships (seed ids actually required across every surface +
  // the versions this build tree resolved for them).
  const clientBundles = [clientEntry, ...Object.values(clientSurfaces)]
    .filter((entry): entry is string => typeof entry === 'string' && files[entry] !== undefined)
    .map(entry => new TextDecoder().decode(files[entry]!))
  const seedAbi = declaredClient && clientBundles.length > 0
    ? await seedAbiStamp(spec.dir, clientBundles)
    : undefined
  files['package.json'] = new TextEncoder().encode(releaseManifest(source, main, spec.exports, seedAbi))
  for (const [subpath, target] of Object.entries(spec.exports ?? {})) {
    if (files[target] === undefined) {
      throw new Error(`pack: ${spec.name} exports ${subpath} to ${target} but the zip does not carry it`)
    }
  }
  // Sources never ship: the zip is a build artifact.
  for (const path of Object.keys(files)) {
    if (path.startsWith('src/')) throw new Error(`pack: ${spec.name} would ship a source file (${path})`)
  }
  return files
}

/** The zip file name a package's release takes under dist-plugins/. */
export function zipFileName(packageName: string): string {
  return `${packageName.replaceAll('/', '__')}.zip`
}

/** The release manifest fields a feed entry carries when the zip declares them. */
interface ReleaseManifestFacts {
  name?: string
  version?: string
  description?: string
  snapRail?: {
    kind?: string
    title?: string
    category?: string
    requires?: string[]
    permissions?: string[]
    engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  }
}

/** One plugin entry the feed's `index.json` carries (feed facts only). */
export interface FeedEntry {
  name: string
  version: string
  description?: string
  kind?: string
  title?: string
  category?: string
  requires?: string[]
  permissions?: string[]
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  /** The pure file name the entry advertises (no path). */
  file: string
  sha256: string
  size: number
  signature?: { algorithm: 'Ed25519', keyId: string }
  repository?: string
}

/**
 * The one feed-entry emitter every producer shares: read a plugin zip's own
 * bytes back (release manifest + signature envelope), derive the
 * `index.json` entry from exactly what the zip carries, and digest the exact
 * bytes the client will download — the feed can never advertise something a
 * zip does not. The repo's pack/collect pipeline and the standalone
 * `snap-rail-plugin feed` command all converge here.
 *
 * @param zipped - the exact zip bytes the feed will serve.
 * @param file - the pure file name the entry advertises (no path).
 * @param fallbackName - the entry's name when the manifest carries none.
 * @param options.requireSignature - refuse unsigned zips (feed policy).
 * @param options.repository - an optional source-repository URL.
 * @returns the entry, unknown fields stripped by construction.
 * @throws when the zip has no readable manifest, or no signature while
 *   `requireSignature` is set.
 */
export function catalogEntryFromZip(
  zipped: Uint8Array,
  file: string,
  fallbackName: string,
  options: { requireSignature?: boolean, repository?: string } = {},
): FeedEntry {
  const files = unzipSync(zipped)
  const manifestFile = files['package.json']
  if (manifestFile === undefined) throw new Error(`catalog: ${file} 缺少 package.json`)
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile)) as ReleaseManifestFacts
  const signatureFile = files['META-INF/signature.json']
  if (signatureFile === undefined && options.requireSignature === true) {
    throw new Error(`catalog: ${file} 没有签名（META-INF/signature.json 缺失）`)
  }
  const signature = signatureFile === undefined
    ? undefined
    : JSON.parse(new TextDecoder().decode(signatureFile)) as ReleaseSignature
  return {
    name: manifest.name ?? fallbackName,
    version: manifest.version ?? '0.0.0',
    ...(manifest.description !== undefined && manifest.description !== '' ? { description: manifest.description } : {}),
    ...(manifest.snapRail?.kind !== undefined ? { kind: manifest.snapRail.kind } : {}),
    ...(manifest.snapRail?.title !== undefined ? { title: manifest.snapRail.title } : {}),
    ...(manifest.snapRail?.category !== undefined ? { category: manifest.snapRail.category } : {}),
    ...(manifest.snapRail?.requires !== undefined ? { requires: manifest.snapRail.requires } : {}),
    ...(manifest.snapRail?.permissions !== undefined ? { permissions: manifest.snapRail.permissions } : {}),
    ...(manifest.snapRail?.engines !== undefined ? { engines: manifest.snapRail.engines } : {}),
    file,
    sha256: createHash('sha256').update(zipped).digest('hex'),
    size: zipped.length,
    ...(signature === undefined ? {} : { signature: { algorithm: signature.algorithm, keyId: signature.keyId } }),
    ...(options.repository === undefined ? {} : { repository: options.repository }),
  }
}
