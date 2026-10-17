/** Release publisher trust configuration for the plugin installer.
 *
 * Two layers merge: the factory-default trust file shipped with the app
 * (`trusted-release-keys.json` beside the built-in layer — the org key that
 * signs the feed's rolling release, so a fresh install verifies first-party
 * packages with zero on-site setup), and the per-home trust file that adds
 * or overrides keys locally. The home layer is deliberately outside the
 * plugin pool: installing a plugin must never be able to add the key that
 * authorizes itself.
 *
 * @module @snap-rail/app-boot/trust
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'

/** The trust file name both layers share. */
export const TRUST_FILE_NAME = 'trusted-release-keys.json'

interface TrustedReleaseKeyDocument {
  keys: Array<{
    keyId: string
    publicKeyPem: string
    publisher?: string
  }>
}

/** Load publisher keys from one trust file.
 *
 * A missing file returns an empty list. A malformed file throws — a broken
 * trust layer must fail loud, not silently reduce the store.
 */
function loadTrustFile(path: string, label: string): readonly TrustedReleaseKey[] {
  if (!existsSync(path)) return []
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (cause) {
    throw new Error(`无法读取${label}信任文件 ${path}`, { cause })
  }
  if (!isTrustedReleaseKeyDocument(document)) throw new Error(`${path} 格式无效：需要 keys[].keyId/publicKeyPem`)
  const ids = new Set<string>()
  for (const entry of document.keys) {
    if (ids.has(entry.keyId)) throw new Error(`${path} 中重复的 keyId：${entry.keyId}`)
    ids.add(entry.keyId)
  }
  return document.keys.map(entry => ({
    keyId: entry.keyId,
    publicKey: parsePublicKey(entry.publicKeyPem, path),
    ...(entry.publisher === undefined ? {} : { publisher: entry.publisher }),
  }))
}

/**
 * The effective trust store: the factory defaults from the app resources
 * (`resourcesDir` = the built-in layer's directory) merged with the per-home
 * file — a home entry with the same keyId overrides the factory one (local
 * publisher remaps), everything else unions. Both layers optional; an empty
 * store still fails closed on unsigned archives.
 *
 * @param homeDir - the snap-rail home (owner of the per-home trust file).
 * @param resourcesDir - the app's resources directory; `undefined` skips the
 *   factory layer (tests, odd hosts).
 */
export function loadTrustedReleaseKeys(homeDir: string, resourcesDir?: string): readonly TrustedReleaseKey[] {
  const factory = resourcesDir === undefined ? [] : loadTrustFile(join(resourcesDir, TRUST_FILE_NAME), '出厂默认')
  const local = loadTrustFile(join(homeDir, TRUST_FILE_NAME), '本机')
  const byId = new Map<string, TrustedReleaseKey>()
  for (const key of factory) byId.set(key.keyId, key)
  for (const key of local) byId.set(key.keyId, key)
  return [...byId.values()]
}

function parsePublicKey(value: string, path: string): KeyObject {
  try {
    return createPublicKey(value)
  } catch (cause) {
    throw new Error(`${path} 中的公钥 ${JSON.stringify(value.slice(0, 32))} 无效`, { cause })
  }
}

function isTrustedReleaseKeyDocument(value: unknown): value is TrustedReleaseKeyDocument {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { keys?: unknown }).keys)) return false
  return (value as { keys: unknown[] }).keys.every(entry => {
    if (typeof entry !== 'object' || entry === null) return false
    const row = entry as { keyId?: unknown, publicKeyPem?: unknown, publisher?: unknown }
    return typeof row.keyId === 'string' && row.keyId.length > 0
      && typeof row.publicKeyPem === 'string' && row.publicKeyPem.includes('PUBLIC KEY')
      && (row.publisher === undefined || typeof row.publisher === 'string')
  })
}
