/**
 * The one catalog-entry emitter every feed producer shares: read a plugin
 * zip's own bytes back (release manifest + signature envelope), derive the
 * `index.json` entry from exactly what the zip carries, and digest the exact
 * bytes the client will download — the feed can never advertise something a
 * zip does not. Both producers (`pack-plugins` over freshly packed zips,
 * `collect-feed` over downloaded release assets) converge here.
 *
 * @module snap-rail/scripts/lib/catalog-entry
 */

import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { ReleaseSignature } from '@snap-rail/plugin-kit/sign'

/** The release manifest fields an entry carries when the zip declares them. */
interface ReleaseManifest {
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

/**
 * Emit one `index.json` entry from a signed plugin zip's bytes.
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
): Record<string, unknown> {
  const files = unzipSync(zipped)
  const manifestFile = files['package.json']
  if (manifestFile === undefined) throw new Error(`catalog: ${file} 缺少 package.json`)
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile)) as ReleaseManifest
  const signatureFile = files['META-INF/signature.json']
  if (signatureFile === undefined) {
    if (options.requireSignature === true) throw new Error(`catalog: ${file} 没有签名（META-INF/signature.json 缺失）`)
  }
  const signature = signatureFile === undefined ? undefined : JSON.parse(new TextDecoder().decode(signatureFile)) as ReleaseSignature
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
