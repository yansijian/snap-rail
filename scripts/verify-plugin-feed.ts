/** Verify a static plugin feed before pointing a terminal at it.
 *
 * This is deliberately transport-agnostic: `--feed` may be an nginx URL or a
 * local directory. It checks the catalog's zip digest and, when `--trust` is
 * supplied, every Ed25519 release envelope as the Host installer does.
 *
 * @module snap-rail/scripts/verify-plugin-feed
 */

import { createHash, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { verifyReleaseFiles, type TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'

interface CatalogEntry {
  name: string
  version: string
  file: string
  sha256?: string
  size?: number
  signature?: { algorithm: 'Ed25519', keyId: string }
}

interface TrustDocument {
  keys: Array<{ keyId: string, publicKeyPem: string, publisher?: string }>
}

const archiveNamePattern = /^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:__[A-Za-z0-9][A-Za-z0-9._-]*)?\.zip$/

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function bytesAt(base: string, file: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(base)) {
    const response = await fetch(new URL(file, base.endsWith('/') ? base : `${base}/`))
    if (!response.ok) throw new Error(`feed: ${response.status} ${response.statusText} for ${file}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  return new Uint8Array(readFileSync(join(resolve(base), file)))
}

function jsonAt(base: string, file: string): unknown {
  if (/^https?:\/\//i.test(base)) throw new Error('feed: use --url for an HTTP feed')
  return JSON.parse(readFileSync(join(resolve(base), file), 'utf8')) as unknown
}

function normalizedArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const archive = unzipSync(bytes)
  const entries = Object.keys(archive).filter(entry => !entry.endsWith('/'))
  const roots = new Set(entries.map(entry => entry.includes('/') ? entry.split('/')[0]! : ''))
  const root = roots.size === 1 && !roots.has('') ? `${[...roots][0]!}/` : ''
  const files: Record<string, Uint8Array> = {}
  for (const [entry, data] of Object.entries(archive)) {
    if (entry.endsWith('/')) continue
    files[root !== '' && entry.startsWith(root) ? entry.slice(root.length) : entry] = data
  }
  return files
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function main(): Promise<void> {
  const base = option('--feed') ?? option('--url')
  if (base === undefined) throw new Error('usage: verify-plugin-feed --feed <directory-or-url> [--trust trusted-release-keys.json]')
  const catalog = (/^https?:\/\//i.test(base)
    ? await (async () => {
        const response = await fetch(new URL('index.json', base.endsWith('/') ? base : `${base}/`))
        if (!response.ok) throw new Error(`feed: ${response.status} ${response.statusText} for index.json`)
        return await response.json() as unknown
      })()
    : jsonAt(base, 'index.json')) as { plugins?: unknown }
  if (!Array.isArray(catalog.plugins)) throw new Error('feed: index.json.plugins must be an array')

  const trustPath = option('--trust')
  const trustProvided = trustPath !== undefined
  let trusted: readonly TrustedReleaseKey[] = []
  if (trustPath !== undefined) {
    const document = JSON.parse(readFileSync(resolve(trustPath), 'utf8')) as TrustDocument
    if (!Array.isArray(document.keys)) throw new Error('trust: keys must be an array')
    trusted = document.keys.map(entry => ({
      keyId: entry.keyId,
      publicKey: createPublicKey(entry.publicKeyPem),
      ...(entry.publisher === undefined ? {} : { publisher: entry.publisher }),
    }))
  }

  const checked: string[] = []
  for (const raw of catalog.plugins) {
    const entry = raw as CatalogEntry
    if (typeof entry.name !== 'string' || typeof entry.file !== 'string') throw new Error('feed: catalog entry lacks name/file')
    if (!archiveNamePattern.test(entry.file)) throw new Error(`feed: unsafe archive file name ${entry.file}`)
    const bytes = await bytesAt(base, entry.file)
    const digest = sha256(bytes)
    if (entry.sha256 === undefined) throw new Error(`feed: ${entry.name} has no sha256`)
    if (entry.sha256 !== digest) throw new Error(`feed: sha256 mismatch for ${entry.name}`)
    if (entry.size === undefined || entry.size !== bytes.length) throw new Error(`feed: size mismatch for ${entry.name}`)
    const files = normalizedArchive(bytes)
    const packageJson = JSON.parse(new TextDecoder().decode(files['package.json'] ?? new Uint8Array())) as { name?: string, version?: string }
    if (packageJson.name !== entry.name || packageJson.version !== entry.version) throw new Error(`feed: manifest identity mismatch for ${entry.name}`)
    if (trustProvided && entry.signature === undefined) throw new Error(`feed: ${entry.name} is unsigned`)
    if (entry.signature !== undefined) {
      if (!trustProvided) throw new Error(`feed: ${entry.name} is signed but --trust was not supplied`)
      const metadata = verifyReleaseFiles(files, trusted)
      if (metadata.name !== entry.name || metadata.version !== entry.version) throw new Error(`feed: signed identity mismatch for ${entry.name}`)
      const signed = JSON.parse(new TextDecoder().decode(files['META-INF/signature.json'] ?? new Uint8Array())) as { keyId?: unknown }
      if (signed.keyId !== entry.signature.keyId) throw new Error(`feed: catalog signature key mismatch for ${entry.name}`)
    }
    checked.push(`${entry.name}@${entry.version}`)
  }
  console.log(JSON.stringify({ ok: true, feed: base, plugins: checked }, null, 2))
}

if (process.argv[1]?.endsWith('verify-plugin-feed.ts') === true) {
  main().catch(cause => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
