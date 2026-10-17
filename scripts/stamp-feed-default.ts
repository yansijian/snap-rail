/**
 * Stamp the factory-default plugin source into the app's shipped
 * `defaults.json` resource — the CI packaging step calls this right before
 * electron-builder picks up `resources/`, so a fresh install boots with the
 * rolling-release feed address without any on-site configuration. The user's
 * later edits ride `settings.json` and win over this default (the read chain
 * is defaults → user; see `@snap-rail/app-boot/feed`). The key is the
 * multi-source list `plugins.feedUrls`; the stamp replaces the list
 * wholesale (CI is the factory layer's owner).
 *
 * Usage: tsx scripts/stamp-feed-default.ts <feed-base-url>
 *
 * @module snap-rail/scripts/stamp-feed-default
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(repoRoot, 'apps/desktop/resources/defaults.json')

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

const url = process.argv[2]
if (url === undefined || url === '' || !/^https?:\/\//i.test(url)) {
  throw new Error('stamp-feed-default: pass the feed base URL, e.g. https://github.com/yansijian/snap-rail/releases/download/feed/')
}

const parsed = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
const normalized = url.endsWith('/') ? url : `${url}/`
parsed['plugins.feedUrls'] = [normalized]
delete parsed['plugins.feedUrl']
writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`)
console.log(`stamp-feed-default: plugins.feedUrls → ${normalized}`)
