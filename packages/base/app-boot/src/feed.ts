/**
 * The plugin feed's host-side fetch layer: read every configured feed's
 * `index.json` catalog (multi-source: the user's `plugins.feedUrls` list,
 * falling back to the factory default stamped in the app's `defaults.json`
 * resource), merge the entries — per name the highest version wins, rows
 * carry their source label — and download one entry's zip to a temp file
 * for the installer, always against the entry's declared digest. Same-
 * directory entries resolve under their feed base; federation entries carry
 * an absolute `url` into the author's own release and download from there.
 * The one client-supplied URL surface is `plugins.inspect-from-url`: a
 * bounded, operator-initiated direct download (http(s) only, size-capped,
 * timeout) whose bytes face the same three-state signature verdict as every
 * other install — not an arbitrary fetch primitive.
 *
 * A feed is a static directory (a GitHub/Gitea release, a web server) with
 * no central index: any author's own release is a valid source, and the
 * official feed only ever carries the org's own first-party artifacts.
 *
 * @module @snap-rail/app-boot/feed
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGINS_FEED_URLS_KEY,
  PLUGINS_FEED_URL_KEY,
  PLUGINS_SIGNATURE_POLICY_KEY,
  remoteCatalogSchema,
  type RemoteAction,
  type RemoteCatalog,
  type RemotePluginInfo,
} from './contract.ts'
import { compareVersions, installedVersionOf } from './installer.ts'
import type { SignaturePolicy } from './installer.ts'

/** Feed failures, machine-readable for the wire mapping. */
export type FeedErrorKind = 'unreachable' | 'bad-catalog' | 'not-found' | 'bad-checksum' | 'bad-url' | 'too-large'

/** One feed failure carrying a machine-readable kind. */
export class FeedError extends Error {
  constructor(public readonly kind: FeedErrorKind, message: string) {
    super(`feed: ${message}`)
    this.name = 'FeedError'
  }
}

/** Catalog reads are small and local; zip downloads get the long leash. */
const CATALOG_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 120_000

function feedBase(feedUrl: string): string {
  return feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
}

/**
 * The feed URLs, read straight from `<home>/settings.json`: the plugins
 * domain must not couple to the settings service's lifecycle (it is the
 * uninstall path for the settings package itself), and the file is the
 * single interface anyway. The list key is `plugins.feedUrls`; the legacy
 * singular `plugins.feedUrl` still reads as a one-element list.
 *
 * @param home - the snap-rail home (owner of `settings.json`).
 * @returns the configured feed base URLs, or `undefined` when unset.
 */
export function readPluginFeedUrls(home: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const list = record[PLUGINS_FEED_URLS_KEY]
    if (Array.isArray(list)) {
      const urls = list.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      return urls.length > 0 ? urls : undefined
    }
    const legacy = record[PLUGINS_FEED_URL_KEY]
    return typeof legacy === 'string' && legacy !== '' ? [legacy] : undefined
  } catch {
    return undefined
  }
}

/** File name of the factory-default settings layer shipped with the app
 * (`defaults.json`, beside the built-in layer; CI stamps real addresses
 * into it at packaging time — the repo copy carries the public GitHub
 * feed). */
const DEFAULTS_FILE_NAME = 'defaults.json'

/**
 * The factory defaults' feed URLs: the layer a fresh install starts from
 * before the user writes anything (same list shape as the user layer, same
 * legacy fallback).
 *
 * @param resourcesDir - the app's resources directory (the built-in layer's
 *   directory — `dirname(builtinLayerPath)`).
 * @returns the default feed base URLs, or `undefined` when the resource or
 *   the keys are absent.
 */
export function readDefaultPluginFeedUrls(resourcesDir: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(resourcesDir, DEFAULTS_FILE_NAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const list = record[PLUGINS_FEED_URLS_KEY]
    if (Array.isArray(list)) {
      const urls = list.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      return urls.length > 0 ? urls : undefined
    }
    const legacy = record[PLUGINS_FEED_URL_KEY]
    return typeof legacy === 'string' && legacy !== '' ? [legacy] : undefined
  } catch {
    return undefined
  }
}

/**
 * The effective feed URLs: the user's `settings.json` list when written,
 * else the factory default — the user layer never falls back to the default
 * mid-flight and the default is never copied into the user's file.
 *
 * @param home - the snap-rail home (owner of `settings.json`).
 * @param resourcesDir - the app's resources directory (owner of
 *   `defaults.json`).
 * @returns the feed base URLs in force, or `undefined` when neither layer
 *   names one.
 */
export function resolvePluginFeedUrls(home: string, resourcesDir: string): readonly string[] | undefined {
  return readPluginFeedUrls(home) ?? readDefaultPluginFeedUrls(resourcesDir)
}

/**
 * The install-time signature gate: `strict` when either layer names it,
 * `open` otherwise (the open web is the default posture; closed fleets opt
 * into strictness via settings or a factory `defaults.json`).
 *
 * @param home - the snap-rail home (owner of `settings.json`).
 * @param resourcesDir - the app's resources directory (owner of
 *   `defaults.json`).
 */
export function resolveSignaturePolicy(home: string, resourcesDir: string): SignaturePolicy {
  const read = (path: string): SignaturePolicy | undefined => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      const value = (parsed as Record<string, unknown>)[PLUGINS_SIGNATURE_POLICY_KEY]
      return value === 'strict' ? 'strict' : value === 'open' ? 'open' : undefined
    } catch {
      return undefined
    }
  }
  return read(join(home, 'settings.json')) ?? read(join(resourcesDir, DEFAULTS_FILE_NAME)) ?? 'open'
}

/** One pending plugin update: an installed package whose feed version is
 * strictly higher. */
export interface PendingUpdate {
  name: string
  installedVersion: string
  feedVersion: string
  /** The feed base this update was listed by (a relative `file` resolves
   * here; a federation `url` ignores it). */
  feedUrl: string
  file?: string
  url?: string
  sha256?: string
  title?: string
  /** The feed entry's signing key id, when the catalog declares one. */
  keyId?: string
  /** The feed entry's key differs from the key the installed copy carries
   * (or the installed copy carries none) — the auto apply skips it; a
   * manual update confirms the change first. */
  keyChanged?: boolean
}

/**
 * Diff merged feed entries against the installed pool: every installed
 * package whose feed version is strictly higher — the same rule a manual
 * update takes (never a downgrade, never a first install; built-ins never
 * sit in the pool so they are never candidates). `installedKeyOf` supplies
 * the key each installed copy carries (the pool scan reads the installed
 * envelope); a mismatching feed key marks the row `keyChanged`.
 *
 * @param entries - the merged feed catalog entries.
 * @param installedVersionOf - the pool's installed version for a package
 *   name, or `undefined` when the package is not installed.
 * @param installedKeyOf - the installed copy's signing key id, or
 *   `undefined` when it carries none.
 */
export function updatableFromCatalog(
  entries: readonly SourcedCatalogEntry[],
  installedVersionOf: (name: string) => string | undefined,
  installedKeyOf?: (name: string) => string | undefined,
): PendingUpdate[] {
  const updates: PendingUpdate[] = []
  for (const entry of entries) {
    const installedVersion = installedVersionOf(entry.name)
    if (installedVersion === undefined) continue
    if (compareVersions(entry.version, installedVersion) <= 0) continue
    const feedKeyId = entry.signature?.keyId
    const installedKey = installedKeyOf?.(entry.name)
    updates.push({
      name: entry.name,
      installedVersion,
      feedVersion: entry.version,
      feedUrl: entry.feedUrl,
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(feedKeyId !== undefined ? { keyId: feedKeyId } : {}),
      ...(feedKeyId !== undefined && feedKeyId !== installedKey ? { keyChanged: true } : {}),
    })
  }
  return updates
}

/**
 * Fetch and validate the feed's catalog.
 *
 * @param feedUrl - the configured feed base URL.
 * @returns the parsed catalog (unknown fields stripped).
 * @throws FeedError `'unreachable'` when the feed can not be read,
 * `'bad-catalog'` when the payload is not a valid catalog.
 */
export async function fetchRemoteCatalog(feedUrl: string): Promise<RemoteCatalog> {
  const base = feedBase(feedUrl)
  let response: Response
  try {
    response = await fetch(`${base}index.json`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
  } catch (cause) {
    throw new FeedError('unreachable', `无法访问插件源 ${base}（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new FeedError('unreachable', `插件源 ${base}index.json 返回 ${response.status}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new FeedError('bad-catalog', `插件源目录 ${base}index.json 不是合法 JSON`)
  }
  const catalog = remoteCatalogSchema.safeParse(parsed)
  if (!catalog.success) {
    const issue = catalog.error.issues[0]
    throw new FeedError('bad-catalog', `插件源目录不合法（${issue?.path.join('.') ?? 'catalog'}: ${issue?.message ?? 'unknown'}）`)
  }
  return catalog.data
}

/** One fetched feed: its validated catalog plus where it came from (the
 * origin base relative `file`s download from, and the label rows annotate). */
export interface FetchedCatalog {
  feedUrl: string
  title?: string
  plugins: RemoteCatalog['plugins']
}

/** One catalog entry annotated with the feed it was listed by. */
export type SourcedCatalogEntry = RemoteCatalog['plugins'][number] & {
  source?: string
  feedUrl: string
}

/**
 * Fetch every configured feed's catalog, tolerating individual failures (a
 * dead community source must not take the org feed down with it).
 *
 * @param feedUrls - the configured feed base URLs.
 * @returns the fetched catalogs in configuration order.
 * @throws FeedError re-throws the first failure when every feed failed.
 */
export async function fetchRemoteCatalogs(feedUrls: readonly string[]): Promise<readonly FetchedCatalog[]> {
  const settled = await Promise.allSettled(feedUrls.map(async feedUrl => {
    const catalog = await fetchRemoteCatalog(feedUrl)
    return { feedUrl, ...(catalog.title !== undefined ? { title: catalog.title } : {}), plugins: catalog.plugins }
  }))
  const fulfilled = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  if (fulfilled.length > 0) return fulfilled
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  throw failure?.reason instanceof FeedError
    ? failure.reason
    : new FeedError('unreachable', `所有插件源均不可达（${feedUrls.join('、')}）`)
}

/**
 * Merge fetched catalogs into one entry list: per package name the highest
 * version wins (the first feed keeps ties), every entry annotated with its
 * source label (the feed's catalog `title`, else its host name) and origin
 * base.
 */
export function mergeCatalogs(catalogs: readonly FetchedCatalog[]): readonly SourcedCatalogEntry[] {
  const byName = new Map<string, SourcedCatalogEntry>()
  for (const catalog of catalogs) {
    const host = (() => {
      try { return new URL(catalog.feedUrl).host } catch { return catalog.feedUrl }
    })()
    const source = catalog.title ?? host
    for (const entry of catalog.plugins) {
      const existing = byName.get(entry.name)
      if (existing !== undefined && compareVersions(entry.version, existing.version) <= 0) continue
      byName.set(entry.name, { ...entry, source, feedUrl: catalog.feedUrl })
    }
  }
  return [...byName.values()]
}

/**
 * Annotate merged catalog entries with the local pool's verdicts: every
 * entry gets the installed version (when present) and the install action.
 *
 * @param entries - the merged feed catalog entries.
 * @param poolDir - the plugin pool directory.
 * @returns the feed view rows, merged order preserved.
 */
export function annotateCatalog(entries: readonly SourcedCatalogEntry[], poolDir: string): RemotePluginInfo[] {
  return entries.map(entry => {
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
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.signature !== undefined ? { signature: entry.signature } : {}),
      ...(entry.engines !== undefined ? { engines: entry.engines } : {}),
      source: entry.source,
      feedUrl: entry.feedUrl,
      ...(installedVersion !== undefined ? { installed: { version: installedVersion } } : {}),
      action,
    }
  })
}

/** Direct downloads share one hard byte ceiling — a feed-relative file is
 * catalog-vouched but the bytes still pass the cap, and federation/direct
 * URLs are operator-side addresses with nothing else bounding them. */
const ADDRESS_INSTALL_MAX_BYTES = 256 * 1024 * 1024

/**
 * Fetch one zip's bytes over http(s): parse + scheme check, one download
 * timeout, the size ceiling checked against both the declared and the
 * received length.
 */
async function fetchZipBytes(url: string): Promise<Uint8Array> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new FeedError('bad-url', `地址不合法：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FeedError('bad-url', `仅支持 http(s) 地址（收到 ${parsed.protocol}//）`)
  }
  let response: Response
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
  } catch (cause) {
    throw new FeedError('unreachable', `下载 ${url} 失败（${cause instanceof Error ? cause.message : String(cause)}）`)
  }
  if (!response.ok) {
    throw new FeedError('unreachable', `下载 ${url} 返回 ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > ADDRESS_INSTALL_MAX_BYTES) {
    throw new FeedError('too-large', `文件超过大小上限（${declared} 字节 > ${ADDRESS_INSTALL_MAX_BYTES}）`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > ADDRESS_INSTALL_MAX_BYTES) {
    throw new FeedError('too-large', `文件超过大小上限（${bytes.byteLength} 字节 > ${ADDRESS_INSTALL_MAX_BYTES}）`)
  }
  return bytes
}

function writeTempZip(prefix: string, bytes: Uint8Array): string {
  const target = join(tmpdir(), `${prefix}-${randomUUID()}.zip`)
  writeFileSync(target, bytes)
  return target
}

/**
 * Download one catalog entry's zip to a temp file — a relative `file` under
 * its feed base, or a federation `url` into the author's own release — and
 * verify the entry's digest against the received bytes before anything
 * touches the disk. The caller owns the file and removes it when the
 * install pipeline is done.
 *
 * @param feedUrl - the entry feed's base URL (relative `file`s resolve here).
 * @param entry - the catalog entry's download coordinates.
 * @param sha256 - the entry's sha256 hex digest; a mismatch aborts.
 * @returns the temp zip's absolute path.
 * @throws FeedError `'unreachable'` when the download fails, `'bad-url'`
 * for a non-http(s) federation address, `'bad-checksum'` when the received
 * bytes do not match the declared digest.
 */
export async function downloadRemotePluginZip(
  feedUrl: string,
  entry: { file?: string | undefined, url?: string | undefined },
  sha256?: string,
): Promise<string> {
  const url = entry.url ?? `${feedBase(feedUrl)}${entry.file ?? ''}`
  const bytes = await fetchZipBytes(url)
  if (sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new FeedError('bad-checksum', `${entry.file ?? url} 完整性校验失败（sha256 不匹配，下载可能损坏或被篡改）`)
  }
  return writeTempZip('snap-rail-feed', bytes)
}

/**
 * Download a plugin or combo zip from an operator-supplied direct URL to a
 * temp file. Bounded on purpose: http(s) only, one download timeout, one
 * size ceiling; no digest exists for a bare URL, so plugin integrity rides
 * entirely on the release signature the installer verifies (an unsigned
 * archive lands as an `unverified` verdict the UI must surface; a combo
 * archive is only as trustworthy as each signed member zip inside it).
 * The caller owns the file.
 *
 * @param url - the direct http(s) URL of a plugin or combo zip.
 * @returns the temp zip's absolute path.
 * @throws FeedError `'bad-url'` for a non-http(s) or unparseable address,
 * `'too-large'` past the ceiling, `'unreachable'` on network failure.
 */
export async function downloadPluginZipFromUrl(url: string): Promise<string> {
  return writeTempZip('snap-rail-address', await fetchZipBytes(url))
}
