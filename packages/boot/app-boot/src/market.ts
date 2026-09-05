/**
 * The plugin market's host-side fetch layer: read a feed's `index.json`
 * catalog, annotate every entry with how installing it would land against
 * the local pool, and download one entry's zip to a temp file for the
 * installer. The feed is the configured base URL (`plugins.feedUrl`
 * settings key); downloads resolve only from catalog file names under that
 * base — the wire never carries a client-chosen URL, so the RPC surface can
 * not be turned into an arbitrary downloader.
 *
 * @module @snap-rail/app-boot/market
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGINS_FEED_URL_KEY,
  remoteCatalogSchema,
  type RemoteAction,
  type RemoteCatalog,
  type RemotePluginInfo,
} from './contract.ts'
import { compareVersions, installedVersionOf } from './installer.ts'

/** Market failures, machine-readable for the wire mapping. */
export type MarketErrorKind = 'unreachable' | 'bad-catalog' | 'not-found'

/** One market failure carrying a machine-readable kind. */
export class MarketError extends Error {
  constructor(public readonly kind: MarketErrorKind, message: string) {
    super(`market: ${message}`)
    this.name = 'MarketError'
  }
}

/** Catalog reads are small and local; zip downloads get the long leash. */
const CATALOG_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 120_000

function feedBase(feedUrl: string): string {
  return feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
}

/**
 * The market feed URL, read straight from `<home>/settings.json`: the
 * plugins domain must not couple to the settings service's lifecycle (it is
 * the uninstall path for the settings package itself), and the file is the
 * single interface anyway.
 *
 * @param home - the snap-rail home (owner of `settings.json`).
 * @returns the configured feed base URL, or `undefined` when unset.
 */
export function readPluginFeedUrl(home: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = (parsed as Record<string, unknown>)[PLUGINS_FEED_URL_KEY]
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Fetch and validate the feed's catalog.
 *
 * @param feedUrl - the configured feed base URL.
 * @returns the parsed catalog (unknown fields stripped).
 * @throws MarketError `'unreachable'` when the feed can not be read,
 * `'bad-catalog'` when the payload is not a valid catalog.
 */
export async function fetchRemoteCatalog(feedUrl: string): Promise<RemoteCatalog> {
  const base = feedBase(feedUrl)
  let response: Response
  try {
    response = await fetch(`${base}index.json`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  } catch (cause) {
    throw new MarketError('unreachable', `无法访问插件源 ${base}（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new MarketError('unreachable', `插件源 ${base}index.json 返回 ${response.status}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new MarketError('bad-catalog', `插件源目录 ${base}index.json 不是合法 JSON`)
  }
  const catalog = remoteCatalogSchema.safeParse(parsed)
  if (!catalog.success) {
    const issue = catalog.error.issues[0]
    throw new MarketError('bad-catalog', `插件源目录不合法（${issue?.path.join('.') ?? 'catalog'}: ${issue?.message ?? 'unknown'}）`)
  }
  return catalog.data
}

/**
 * Annotate a parsed catalog with the local pool's verdicts: every entry
 * gets the installed version (when present) and the install action.
 *
 * @param catalog - the validated feed catalog.
 * @param poolDir - the plugin pool directory.
 * @returns the market view rows, catalog order preserved.
 */
export function annotateCatalog(catalog: RemoteCatalog, poolDir: string): RemotePluginInfo[] {
  return catalog.plugins.map(entry => {
    const installedVersion = installedVersionOf(poolDir, entry.name)
    let action: RemoteAction = 'install'
    if (installedVersion !== undefined) {
      const order = compareVersions(entry.version, installedVersion)
      action = order > 0 ? 'update' : order === 0 ? 'current' : 'local-newer'
    }
    return {
      name: entry.name,
      version: entry.version,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      file: entry.file,
      ...(installedVersion !== undefined ? { installed: { version: installedVersion } } : {}),
      action,
    }
  })
}

/**
 * Download one catalog entry's zip to a temp file. The caller owns the file
 * and removes it when the install pipeline is done with it.
 *
 * @param feedUrl - the configured feed base URL.
 * @param file - the catalog entry's file name (validated relative name).
 * @returns the temp zip's absolute path.
 * @throws MarketError `'unreachable'` when the download fails.
 */
export async function downloadRemotePluginZip(feedUrl: string, file: string): Promise<string> {
  const base = feedBase(feedUrl)
  let response: Response
  try {
    response = await fetch(`${base}${file}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (cause) {
    throw new MarketError('unreachable', `下载 ${base}${file} 失败（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new MarketError('unreachable', `下载 ${base}${file} 返回 ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const target = join(tmpdir(), `snap-rail-market-${randomUUID()}.zip`)
  writeFileSync(target, bytes)
  return target
}
