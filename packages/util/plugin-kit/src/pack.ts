/**
 * Final-format assembly: turn a built plugin package into the file set of
 * its installable zip. The zip is **the release artifact, not the source
 * tree** — a trimmed manifest whose `main` names the host face, the built
 * host face itself, and (when the manifest declares `snapRail.client`) the
 * built client bundle with its emitted assets. The settings page's 安装插件,
 * the CLI packer, and the future marketplace all consume the same shape.
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
  snapRail?: unknown
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
   * Declarations, source maps, and tsbuildinfo files never ship. */
  hostDir: string
  /** Path inside the package of the host face entry — becomes the manifest
   * `main` (the pool mounts exactly one host entry per package). */
  hostFace: string
  /** Directory inside the package holding the built client bundle and its
   * assets; required iff the manifest declares `snapRail.client`. */
  clientFace?: string | undefined
}

/** Files a release never carries even inside a face directory. */
function isBuildPlumbing(path: string): boolean {
  return path.endsWith('.d.ts') || path.endsWith('.d.ts.map') || path.endsWith('.js.map')
    || path.endsWith('.tsbuildinfo')
}

/**
 * Derive the release manifest: the npm identity plus the host face as
 * `main`. Everything else (scripts, dev dependencies, exports maps) is
 * workspace plumbing the pool never reads and the zip never carries.
 *
 * @param source - the parsed source `package.json`.
 * @param hostFace - the host face path that becomes `main`.
 * @returns the manifest serialized for the zip root.
 */
export function releaseManifest(source: SourceManifest, hostFace: string): string {
  const snapRail = source.snapRail
  const manifest: Record<string, unknown> = {
    name: source.name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    description: typeof source.description === 'string' ? source.description : '',
    type: 'module',
    main: hostFace,
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
 * Assemble one package's release file set: the release manifest, the host
 * face, and — when declared — the client bundle directory. Fails loud when
 * the source manifest drifts from the spec or a declared face is missing on
 * disk, so a broken build can never ship as a plausible zip.
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
  const snapRail = source.snapRail as { client?: { entry?: unknown } } | undefined
  const declaredClient = snapRail?.client !== undefined
  if (declaredClient !== (spec.clientFace !== undefined)) {
    throw new Error(`pack: ${spec.name} declares snapRail.client ${declaredClient ? 'with' : 'without'} a clientFace directory`)
  }

  const files: Record<string, Uint8Array> = {
    'package.json': new TextEncoder().encode(releaseManifest(source, spec.hostFace)),
  }
  Object.assign(files, await collectDir(join(spec.dir, spec.hostDir), spec.dir))
  if (files[spec.hostFace] === undefined) {
    throw new Error(`pack: ${spec.name} is missing its host face ${spec.hostFace} under ${spec.hostDir}`)
  }
  if (spec.clientFace !== undefined) {
    Object.assign(files, await collectDir(join(spec.dir, spec.clientFace), spec.dir))
  }

  if (declaredClient) {
    const entry = snapRail?.client?.entry
    const clientEntry = typeof entry === 'string' ? entry : 'lib/client.js'
    if (files[clientEntry] === undefined) {
      throw new Error(`pack: ${spec.name} declares client entry ${clientEntry} but the zip does not carry it`)
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
