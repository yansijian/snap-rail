/**
 * Final-format assembly: turn a built plugin package into the file set of
 * its installable zip. The zip is **the release artifact, not the source
 * tree** — a trimmed manifest whose `main` names the host face (or, for
 * `clientOnly` packages, the client bundle), the built faces themselves, and
 * an `exports` map covering the subpaths pool-resident importers resolve
 * (`./contract` and friends). The settings page's 安装插件, the CLI packer,
 * and the future marketplace all consume the same shape.
 *
 * @module @snap-rail/plugin-kit/pack
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The manifest fields the release manifest carries over from the source. */
interface SourceManifest {
  name?: unknown
  version?: unknown
  description?: unknown
  snapRail?: {
    clientOnly?: unknown
    client?: { entry?: unknown } | undefined
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
 * plumbing the pool never reads and the zip never carries.
 *
 * @param source - the parsed source `package.json`.
 * @param main - the entry the manifest `main` names.
 * @param exports - subpath exports beyond `.`; the root voice is always
 * included.
 * @returns the manifest serialized for the zip root.
 */
export function releaseManifest(source: SourceManifest, main: string, exports?: Readonly<Record<string, string>>): string {
  const snapRail = source.snapRail
  const manifest: Record<string, unknown> = {
    name: source.name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    description: typeof source.description === 'string' ? source.description : '',
    type: 'module',
    main,
    exports: { '.': main, ...exports },
  }
  if (snapRail !== undefined) manifest.snapRail = snapRail
  return `${JSON.stringify(manifest, null, 2)}\n`
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
  const main = spec.hostFace ?? clientEntry

  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(releaseManifest(source, main, spec.exports)),
  }
  if (spec.hostDir !== undefined) {
    Object.assign(files, await collectDir(join(spec.dir, spec.hostDir), spec.dir))
    // The tsc staging tree (`<hostDir>/types` — type-stripped intermediates the
    // two-stage build emits beside the faces, stale files included) is build
    // plumbing like declarations and maps; it never ships.
    for (const path of Object.keys(files)) {
      if (path === `${spec.hostDir}/types` || path.startsWith(`${spec.hostDir}/types/`)) delete files[path]
    }
  }
  if (spec.hostFace !== undefined && files[spec.hostFace] === undefined) {
    throw new Error(`pack: ${spec.name} is missing its host face ${spec.hostFace} under ${String(spec.hostDir)}`)
  }
  if (spec.clientFace !== undefined) {
    Object.assign(files, await collectDir(join(spec.dir, spec.clientFace), spec.dir))
  }
  if (declaredClient && files[clientEntry] === undefined) {
    throw new Error(`pack: ${spec.name} declares client entry ${clientEntry} but the zip does not carry it`)
  }
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
