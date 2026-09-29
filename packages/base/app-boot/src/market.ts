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

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import {
  PLUGINS_FEED_URL_KEY,
  recipePayloadSchema,
  remoteCatalogSchema,
  remoteRecipesSchema,
  type RecipePayload,
  type RemoteAction,
  type RemoteCatalog,
  type RemotePluginInfo,
  type RemoteRecipes,
} from './contract.ts'
import { compareVersions, installedVersionOf } from './installer.ts'

/** Market failures, machine-readable for the wire mapping. */
export type MarketErrorKind = 'unreachable' | 'bad-catalog' | 'not-found' | 'bad-checksum'

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

/** One pending plugin update: an installed package whose feed version is
 * strictly higher. */
export interface PendingUpdate {
  name: string
  installedVersion: string
  feedVersion: string
  file: string
  sha256?: string
  title?: string
}

/**
 * Diff a feed catalog against the installed pool: every installed package
 * whose feed version is strictly higher — the same rule a manual update
 * takes (never a downgrade, never a first install; built-ins never sit in
 * the pool so they are never candidates).
 *
 * @param catalog - the fetched feed catalog entries.
 * @param installedVersionOf - the pool's installed version for a package
 *   name, or `undefined` when the package is not installed.
 */
export function updatableFromCatalog(
  catalog: RemoteCatalog['plugins'],
  installedVersionOf: (name: string) => string | undefined,
): PendingUpdate[] {
  const updates: PendingUpdate[] = []
  for (const entry of catalog) {
    const installedVersion = installedVersionOf(entry.name)
    if (installedVersion === undefined) continue
    if (compareVersions(entry.version, installedVersion) <= 0) continue
    updates.push({
      name: entry.name,
      installedVersion,
      feedVersion: entry.version,
      file: entry.file,
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    })
  }
  return updates
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
 * Fetch and validate the feed's recipe catalog (`recipes.json`, served
 * beside `index.json`).
 *
 * @param feedUrl - the configured feed base URL.
 * @returns the parsed recipe catalog (unknown fields stripped).
 * @throws MarketError `'unreachable'` when the feed can not be read,
 * `'bad-catalog'` when the payload is not a valid recipe catalog.
 */
export async function fetchRemoteRecipes(feedUrl: string): Promise<RemoteRecipes> {
  const base = feedBase(feedUrl)
  let response: Response
  try {
    response = await fetch(`${base}recipes.json`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  } catch (cause) {
    throw new MarketError('unreachable', `无法访问插件源 ${base}（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new MarketError('unreachable', `插件源 ${base}recipes.json 返回 ${response.status}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new MarketError('bad-catalog', `插件源组合目录 ${base}recipes.json 不是合法 JSON`)
  }
  const recipes = remoteRecipesSchema.safeParse(parsed)
  if (!recipes.success) {
    const issue = recipes.error.issues[0]
    throw new MarketError('bad-catalog', `组合目录不合法（${issue?.path.join('.') ?? 'recipes'}: ${issue?.message ?? 'unknown'}）`)
  }
  return recipes.data
}

/**
 * Fetch and strictly validate one recipe document: the exact `plugins.yml`
 * shape, because the document lands verbatim as a preset file.
 *
 * @param feedUrl - the configured feed base URL.
 * @param file - the recipe entry's file name (validated relative name).
 * @returns the parsed recipe payload.
 * @throws MarketError `'unreachable'` when the document can not be read,
 * `'bad-catalog'` when it is not valid YAML of the recipe shape.
 */
export async function fetchRecipeDocument(feedUrl: string, file: string): Promise<RecipePayload> {
  const base = feedBase(feedUrl)
  let response: Response
  try {
    response = await fetch(`${base}${file}`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  } catch (cause) {
    throw new MarketError('unreachable', `无法访问插件源 ${base}（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new MarketError('unreachable', `组合文档 ${base}${file} 返回 ${response.status}`)
  }
  let parsed: unknown
  try {
    parsed = load(await response.text())
  } catch {
    throw new MarketError('bad-catalog', `组合文档 ${file} 不是合法 YAML`)
  }
  const payload = recipePayloadSchema.safeParse(parsed)
  if (!payload.success) {
    const issue = payload.error.issues[0]
    throw new MarketError('bad-catalog', `组合文档不合法（${file}: ${issue?.path.join('.') ?? 'plugins'}: ${issue?.message ?? 'unknown'}）`)
  }
  return payload.data
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
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
      ...(entry.framework !== undefined ? { framework: entry.framework } : {}),
      file: entry.file,
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
      ...(entry.engines !== undefined ? { engines: entry.engines } : {}),
      ...(installedVersion !== undefined ? { installed: { version: installedVersion } } : {}),
      action,
    }
  })
}

/**
 * Download one catalog entry's zip to a temp file, verifying the digest the
 * signed catalog against the received bytes before anything touches the disk.
 * The caller owns the file and removes it when the install pipeline is done.
 *
 * @param feedUrl - the configured feed base URL.
 * @param file - the catalog entry's file name (validated relative name).
 * @param sha256 - the entry's sha256 hex digest; a mismatch aborts.
 * @returns the temp zip's absolute path.
 * @throws MarketError `'unreachable'` when the download fails, `'bad-checksum'`
 * when the received bytes do not match the declared digest.
 */
export async function downloadRemotePluginZip(feedUrl: string, file: string, sha256?: string): Promise<string> {
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
  if (sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new MarketError('bad-checksum', `${file} 完整性校验失败（sha256 不匹配，下载可能损坏或被篡改）`)
  }
  const target = join(tmpdir(), `snap-rail-market-${randomUUID()}.zip`)
  writeFileSync(target, bytes)
  return target
}
