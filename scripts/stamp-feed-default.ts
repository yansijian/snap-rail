/**
 * Stamp the factory-default feed base — the single address every channel
 * derives from. The source of truth is `feed-base.json` at the repo root;
 * this script applies it to the three places that must never drift:
 *
 *   1. `apps/desktop/resources/defaults.json` → `plugins.feedUrls`
 *      (the factory plugin source a fresh install boots with),
 *   2. `apps/desktop/electron-builder.yml` → `publish.url`
 *      (the desktop updater's built-in default),
 *   3. `website/src/generated/catalog.ts` → `FEED_BASE`
 *      (the website's download base for plugin/zip/installer cards).
 *
 * The user's later source edits ride `settings.json` and win over the
 * default (the read chain is defaults → user; see `@snap-rail/app-boot/feed`).
 *
 * Usage:
 *   tsx scripts/stamp-feed-default.ts            # apply feed-base.json
 *   tsx scripts/stamp-feed-default.ts <base-url> # switch the base, then apply
 *   tsx scripts/stamp-feed-default.ts --check    # verify all places agree
 *
 * A base switch is not complete until the site is rebuilt
 * (`pnpm run site:build` + `site:sync-oss`) and a new installer is cut —
 * the old installer keeps its baked address, which is why the bucket keeps
 * serving the old base until every client has rotated.
 *
 * @module snap-rail/scripts/stamp-feed-default
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseFile = join(repoRoot, 'feed-base.json')
const defaultsPath = join(repoRoot, 'apps/desktop/resources/defaults.json')
const builderPath = join(repoRoot, 'apps/desktop/electron-builder.yml')
const catalogPath = join(repoRoot, 'website/src/generated/catalog.ts')

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

function readBaseFile(): string {
  if (!existsSync(baseFile)) {
    throw new Error(`stamp-feed-default: 缺少 ${baseFile} —— 先传一个基址参数建立它`)
  }
  const parsed = JSON.parse(readFileSync(baseFile, 'utf8')) as { feedBase?: unknown }
  if (typeof parsed.feedBase !== 'string' || !/^https?:\/\/.+/.test(parsed.feedBase)) {
    throw new Error('stamp-feed-default: feed-base.json.feedBase 不是合法的 http(s) 基址')
  }
  return parsed.feedBase
}

const argument = process.argv[2]
const check = argument === '--check'
if (!check && argument !== undefined && !/^https?:\/\//i.test(argument)) {
  throw new Error('stamp-feed-default: 参数应是基址 URL（…/feed/）或 --check')
}

let base = readBaseFile()
if (!check && argument !== undefined) {
  base = `${argument.replace(/\/*$/, '')}/`
  writeFileSync(baseFile, `${JSON.stringify({ feedBase: base }, null, 2)}\n`)
  console.log(`stamp-feed-default: feed-base.json → ${base}`)
}

/** The catalog's FEED_BASE line, or null when the site catalog is absent. */
function catalogFeedBase(): string | null {
  if (!existsSync(catalogPath)) return null
  return /^export const FEED_BASE = "(.+)"$/m.exec(readFileSync(catalogPath, 'utf8'))?.[1] ?? null
}

function stampDefaults(): void {
  const parsed = JSON.parse(readFileSync(defaultsPath, 'utf8')) as Record<string, unknown>
  parsed['plugins.feedUrls'] = [base]
  delete parsed['plugins.feedUrl']
  writeFileSync(defaultsPath, `${JSON.stringify(parsed, null, 2)}\n`)
}

function stampBuilder(): void {
  const builder = readFileSync(builderPath, 'utf8')
  const publishIndex = builder.indexOf('\npublish:')
  if (publishIndex < 0) throw new Error('stamp-feed-default: electron-builder.yml 缺少 publish 段')
  const head = builder.slice(0, publishIndex)
  const tail = builder.slice(publishIndex)
  const stamped = tail.replace(/^(\s*url:\s*)\S+.*$/m, `$1${base}`)
  if (stamped === tail) throw new Error('stamp-feed-default: publish 段里没有找到 url 行')
  writeFileSync(builderPath, head + stamped)
}

function stampCatalog(): void {
  if (!existsSync(catalogPath)) return
  const catalog = readFileSync(catalogPath, 'utf8')
  const stamped = catalog.replace(/^export const FEED_BASE = ".+"$/m, `export const FEED_BASE = ${JSON.stringify(base)}`)
  if (stamped === catalog) throw new Error('stamp-feed-default: catalog.ts 里没有找到 FEED_BASE 行')
  writeFileSync(catalogPath, stamped)
}

if (check) {
  const mismatches: string[] = []
  const defaults = JSON.parse(readFileSync(defaultsPath, 'utf8')) as Record<string, unknown>
  const defaultsBase = (defaults['plugins.feedUrls'] as string[] | undefined)?.[0]
  if (defaultsBase !== base) mismatches.push(`defaults.json: ${defaultsBase ?? '(缺)'}`)
  if (!new RegExp(`^\\s*url:\\s*${base.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}`, 'm').test(readFileSync(builderPath, 'utf8'))) {
    mismatches.push('electron-builder.yml publish.url')
  }
  const catalogBase = catalogFeedBase()
  if (catalogBase !== null && catalogBase !== base) mismatches.push(`catalog.ts: ${catalogBase}`)
  if (mismatches.length > 0) {
    console.error(`verify:feed-base — FAIL（feed-base.json = ${base}）`)
    for (const mismatch of mismatches) console.error(`- ${mismatch}`)
    console.error('运行 pnpm exec tsx scripts/stamp-feed-default.ts 统一到 feed-base.json')
    process.exitCode = 1
  } else {
    console.log(`verify:feed-base — clean（${base}）`)
  }
} else {
  stampDefaults()
  console.log(`stamp-feed-default: plugins.feedUrls → ${base}`)
  stampBuilder()
  console.log(`stamp-feed-default: electron-builder.yml publish.url → ${base}`)
  stampCatalog()
  console.log(`stamp-feed-default: catalog.ts FEED_BASE → ${base}`)
  console.log('基址切换收尾：pnpm run site:build && pnpm run site:sync-oss，并重出一版安装包（旧安装包仍指向旧基址，桶需继续服务）。')
}
