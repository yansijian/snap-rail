/** Release publisher trust configuration for the plugin installer.
 *
 * The trust file is deliberately outside the plugin pool. Installing a
 * plugin must never be able to add the key that authorizes itself.
 *
 * @module @snap-rail/app-boot/trust
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'

/** The per-home trust file name. */
export const TRUST_FILE_NAME = 'trusted-release-keys.json'

interface TrustedReleaseKeyDocument {
  keys: Array<{
    keyId: string
    publicKeyPem: string
    publisher?: string
  }>
}

/** Load publisher keys from the host-owned trust file.
 *
 * A missing file returns an empty trust store. The RPC install path passes the
 * result to the verifier, so unsigned archives and unknown publishers still
 * fail closed when the store has not been configured yet.
 */
export function loadTrustedReleaseKeys(homeDir: string): readonly TrustedReleaseKey[] {
  const path = join(homeDir, TRUST_FILE_NAME)
  if (!existsSync(path)) return []
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (cause) {
    throw new Error(`无法读取发布者信任文件 ${path}`, { cause })
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
