/**
 * Feed collector: assemble the org's own standalone plugin repositories'
 * release zips into one directory — `index.json` entries read back out of
 * the signed zips themselves (manifest, signature, digest), so the feed can
 * never advertise something a zip does not carry. The publish pipeline
 * merges the directory via `--collect` (its entries win collisions) and
 * syncs the rolling release; `verify:feed` then checks the assembled feed
 * against the release trust store.
 *
 * This is first-party collection only: community authors own their feeds and
 * users add them by URL. Sources come from `feed-sources.json`; each names
 * the repo, the release asset, and — locally — the already-built dist
 * directory. The CI collect workflow downloads the latest release assets
 * instead and passes that directory here.
 *
 * Usage:
 *   tsx scripts/collect-feed.ts                          # feeds from `local` dirs
 *   tsx scripts/collect-feed.ts --from <dir>             # zips already downloaded
 *   tsx scripts/collect-feed.ts --out <dir>              # default collect-out/
 *   tsx scripts/collect-feed.ts --provider gitea|github  # source-repository URL base
 *
 * @module snap-rail/scripts/collect-feed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { catalogEntryFromZip } from './lib/catalog-entry.ts'

type FeedProvider = 'gitea' | 'github'

interface FeedSource {
  repo: string
  asset: string
  /** Local dist directory holding the built zip (local runs). */
  local?: string
}

interface FeedSources {
  /** The default repository-URL provider when `--provider` is absent. */
  provider?: FeedProvider
  /** Provider → organization/user URL base for source-repository links. */
  providers?: Partial<Record<FeedProvider, string>>
  sources: FeedSource[]
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function providerArg(): FeedProvider | undefined {
  const value = option('--provider')
  if (value === undefined) return undefined
  if (value !== 'gitea' && value !== 'github') throw new Error(`collect: --provider 只支持 gitea 或 github（收到 ${value}）`)
  return value
}

function main(): void {
  const root = join(import.meta.dirname, '..')
  const outDir = resolve(option('--out') ?? join(root, 'collect-out'))
  const downloadDir = option('--from')
  const document = JSON.parse(readFileSync(join(root, 'feed-sources.json'), 'utf8')) as FeedSources
  const provider = providerArg() ?? document.provider ?? 'gitea'
  const repositoryBase = document.providers?.[provider]?.replace(/\/+$/, '')
  const repositoryOf = (repo: string): string | undefined =>
    repositoryBase === undefined || repositoryBase === '' ? undefined : `${repositoryBase}/${repo}`

  mkdirSync(outDir, { recursive: true })
  const entries: Array<Record<string, unknown>> = []
  for (const source of document.sources) {
    const zipPath = downloadDir !== undefined
      ? join(resolve(downloadDir), source.asset)
      : join(root, source.local ?? throwMissingLocal(source.repo), source.asset)
    if (!existsSync(zipPath)) {
      // A repo without its first release yet only thins the feed; the next
      // collect run picks it up. Never kill the whole refresh for one source.
      console.warn(`collect: SKIP ${source.repo} — zip 不存在（未发版或未构建）：${zipPath}`)
      continue
    }
    const zipped = new Uint8Array(readFileSync(zipPath))
    writeFileSync(join(outDir, source.asset), zipped)
    const repository = repositoryOf(source.repo)
    entries.push(catalogEntryFromZip(zipped, source.asset, source.asset, {
      requireSignature: true,
      ...(repository === undefined ? {} : { repository }),
    }))
    const version = (entries[entries.length - 1]!.version as string) ?? '?'
    console.log(`collected ${source.asset} (${version}, ${(zipped.length / 1024).toFixed(0)} KiB)`)
  }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ plugins: entries }, null, 2)}\n`)
  console.log(`collect: wrote ${join(outDir, 'index.json')} (${entries.length} plugins, provider ${provider})`)
}

function throwMissingLocal(repo: string): never {
  throw new Error(`collect: ${repo} 没有声明 local dist；本地运行前先构建该仓，或用 --from 指向下载目录`)
}

main()
