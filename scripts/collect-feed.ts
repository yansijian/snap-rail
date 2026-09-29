/**
 * Feed collector: assemble the standalone plugin repositories' release zips
 * into one market directory — `index.json` entries read back out of the
 * signed zips themselves (manifest, signature, digest), so the feed can
 * never advertise something a zip does not carry. The publish pipeline
 * merges the directory via `--market` (its index wins collisions) and
 * syncs the feed branch; `verify:market` then checks the assembled feed
 * against the release trust store.
 *
 * Sources come from `feed-sources.json`: each names the Gitea repo, the
 * release asset, and — locally — the already-built dist directory. The CI
 * collect workflow downloads the latest release assets instead and passes
 * that directory here.
 *
 * Usage:
 *   tsx scripts/collect-feed.ts                    # feeds from `local` dirs
 *   tsx scripts/collect-feed.ts --from <dir>       # zips already downloaded
 *   tsx scripts/collect-feed.ts --out <dir>        # default collect-out/
 *
 * @module snap-rail/scripts/collect-feed
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import type { ReleaseSignature } from '@snap-rail/plugin-kit/sign'

interface FeedSource {
  repo: string
  asset: string
  /** Local dist directory holding the built zip (local runs). */
  local?: string
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function main(): void {
  const root = join(import.meta.dirname, '..')
  const outDir = resolve(option('--out') ?? join(root, 'collect-out'))
  const downloadDir = option('--from')
  const sources = (JSON.parse(readFileSync(join(root, 'feed-sources.json'), 'utf8')) as { sources: FeedSource[] }).sources

  mkdirSync(outDir, { recursive: true })
  const entries: Array<Record<string, unknown>> = []
  for (const source of sources) {
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
    const files = unzipSync(zipped)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as {
      version?: string
      description?: string
      snapRail?: {
        kind?: string
        title?: string
        category?: string
        requires?: string[]
        framework?: string
        permissions?: string[]
        capabilities?: { provides?: { id: string, version: string }[], requires?: { id: string, range: string, optional?: boolean }[] }
        engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
      }
    }
    const signatureFile = files['META-INF/signature.json']
    if (signatureFile === undefined) throw new Error(`collect: ${source.asset} 没有签名（META-INF/signature.json 缺失）`)
    const signature = JSON.parse(new TextDecoder().decode(signatureFile)) as ReleaseSignature
    writeFileSync(join(outDir, source.asset), zipped)
    entries.push({
      name: manifest.name ?? source.asset,
      version: manifest.version ?? '0.0.0',
      ...(manifest.description !== undefined && manifest.description !== '' ? { description: manifest.description } : {}),
      ...(manifest.snapRail?.kind !== undefined ? { kind: manifest.snapRail.kind } : {}),
      ...(manifest.snapRail?.title !== undefined ? { title: manifest.snapRail.title } : {}),
      ...(manifest.snapRail?.category !== undefined ? { category: manifest.snapRail.category } : {}),
      ...(manifest.snapRail?.requires !== undefined ? { requires: manifest.snapRail.requires } : {}),
      ...(manifest.snapRail?.framework !== undefined ? { framework: manifest.snapRail.framework } : {}),
      ...(manifest.snapRail?.permissions !== undefined ? { permissions: manifest.snapRail.permissions } : {}),
      ...(manifest.snapRail?.capabilities !== undefined ? { capabilities: manifest.snapRail.capabilities } : {}),
      ...(manifest.snapRail?.engines !== undefined ? { engines: manifest.snapRail.engines } : {}),
      file: source.asset,
      sha256: createHash('sha256').update(zipped).digest('hex'),
      size: zipped.length,
      signature: { algorithm: signature.algorithm, keyId: signature.keyId },
      repository: `http://192.168.1.9:3000/snap-rail/${source.repo}`,
    })
    console.log(`collected ${source.asset} (${manifest.version ?? '?'}, ${(zipped.length / 1024).toFixed(0)} KiB)`)
  }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ plugins: entries }, null, 2)}\n`)
  console.log(`collect: wrote ${outDir}${'/'}index.json (${entries.length} plugins)`)
}

function throwMissingLocal(repo: string): never {
  throw new Error(`collect: ${repo} 没有声明 local dist；本地运行前先构建该仓，或用 --from 指向下载目录`)
}

main()
