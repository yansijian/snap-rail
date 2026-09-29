/**
 * Release metadata and Ed25519 signatures for installable plugins.
 *
 * The signature covers a canonical release manifest. The manifest contains a
 * digest for every payload file, so the verifier authenticates both the
 * publisher and the bytes that will be installed without signing the zip
 * container itself.
 *
 * @module @snap-rail/plugin-kit/sign
 */

import { createHash, sign, verify, type KeyObject } from 'node:crypto'

/** The metadata file embedded in a release archive. */
export const RELEASE_METADATA_PATH = 'META-INF/release.json'
/** The signature envelope embedded in a release archive. */
export const RELEASE_SIGNATURE_PATH = 'META-INF/signature.json'

/** A release manifest's file digest table. */
export interface ReleaseFileDigests {
  readonly [path: string]: string
}

/** Signed metadata carried by one plugin release. */
export interface ReleaseMetadata {
  format: 1
  name: string
  version: string
  publisher?: string
  createdAt: string
  files: ReleaseFileDigests
}

/** The detached signature envelope carried by one plugin release. */
export interface ReleaseSignature {
  algorithm: 'Ed25519'
  keyId: string
  signedFile: typeof RELEASE_METADATA_PATH
  signature: string
}

/** A trusted public key indexed by the publisher's stable key id. */
export interface TrustedReleaseKey {
  keyId: string
  publicKey: KeyObject | string | Uint8Array
  publisher?: string
}

/** Stable JSON serialization used as the Ed25519 signing input. */
export function canonicalJson(value: unknown): string {
  return `${canonicalValue(value)}\n`
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('release metadata contains an unsupported primitive')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('release metadata contains an unsupported value')
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
  return `{${entries.join(',')}}`
}

/** SHA-256 digest of one payload file. */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Build signed metadata from a release file set. Metadata and signature files
 * are excluded from the digest table so signing never becomes recursive.
 */
export function releaseMetadata(files: Readonly<Record<string, Uint8Array>>, options: {
  name: string
  version: string
  publisher?: string
  createdAt?: string
}): ReleaseMetadata {
  const digests: Record<string, string> = {}
  for (const path of Object.keys(files).sort()) {
    if (path === RELEASE_METADATA_PATH || path === RELEASE_SIGNATURE_PATH) continue
    digests[path] = `sha256:${sha256(files[path]!)}`
  }
  return {
    format: 1,
    name: options.name,
    version: options.version,
    ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
    createdAt: options.createdAt ?? new Date().toISOString(),
    files: digests,
  }
}

/** Sign release metadata with an Ed25519 private key. */
export function signReleaseMetadata(metadata: ReleaseMetadata, key: {
  keyId: string
  privateKey: KeyObject | string | Uint8Array
}): ReleaseSignature {
  const bytes = Buffer.from(canonicalJson(metadata), 'utf8')
  return {
    algorithm: 'Ed25519',
    keyId: key.keyId,
    signedFile: RELEASE_METADATA_PATH,
    signature: sign(null, bytes, key.privateKey as KeyObject | string | Buffer).toString('base64'),
  }
}

/** Add signed metadata and signature files to a release file set. */
export function signReleaseFiles(files: Readonly<Record<string, Uint8Array>>, options: {
  name: string
  version: string
  keyId: string
  privateKey: KeyObject | string | Uint8Array
  publisher?: string
  createdAt?: string
}): Record<string, Uint8Array> {
  const metadata = releaseMetadata(files, options)
  const signature = signReleaseMetadata(metadata, options)
  return {
    ...files,
    [RELEASE_METADATA_PATH]: new TextEncoder().encode(canonicalJson(metadata)),
    [RELEASE_SIGNATURE_PATH]: new TextEncoder().encode(canonicalJson(signature)),
  }
}

/** Verify release metadata, signature and every payload file digest. */
export function verifyReleaseFiles(files: Readonly<Record<string, Uint8Array>>, trustedKeys: readonly TrustedReleaseKey[]): ReleaseMetadata {
  const metadataBytes = files[RELEASE_METADATA_PATH]
  const signatureBytes = files[RELEASE_SIGNATURE_PATH]
  if (metadataBytes === undefined || signatureBytes === undefined) throw new Error('release signature metadata is missing')
  const metadata = parseJson<ReleaseMetadata>(metadataBytes, 'release metadata')
  const signature = parseJson<ReleaseSignature>(signatureBytes, 'release signature')
  if (metadata.format !== 1 || signature.algorithm !== 'Ed25519' || signature.signedFile !== RELEASE_METADATA_PATH) {
    throw new Error('unsupported release signature format')
  }
  if (Object.prototype.hasOwnProperty.call(metadata.files, RELEASE_METADATA_PATH)
    || Object.prototype.hasOwnProperty.call(metadata.files, RELEASE_SIGNATURE_PATH)) {
    throw new Error('release digest table must not include signature metadata')
  }
  const key = trustedKeys.find(candidate => candidate.keyId === signature.keyId)
  if (key === undefined) throw new Error(`untrusted release key ${signature.keyId}`)
  if (key.publisher !== undefined && metadata.publisher !== key.publisher) throw new Error('release publisher does not match the trusted key')
  const valid = verify(
    null,
    Buffer.from(canonicalJson(metadata), 'utf8'),
    key.publicKey as KeyObject | string | Buffer,
    Buffer.from(signature.signature, 'base64'),
  )
  if (!valid) throw new Error('release signature is invalid')
  const expected = new Set(Object.keys(metadata.files))
  for (const path of Object.keys(files)) {
    if (path === RELEASE_METADATA_PATH || path === RELEASE_SIGNATURE_PATH) continue
    if (!expected.has(path)) throw new Error(`release contains an unsigned file ${path}`)
  }
  for (const [path, digest] of Object.entries(metadata.files)) {
    const data = files[path]
    if (data === undefined) throw new Error(`release is missing signed file ${path}`)
    if (digest !== `sha256:${sha256(data)}`) throw new Error(`release file digest mismatch for ${path}`)
  }
  return metadata
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause })
  }
}
