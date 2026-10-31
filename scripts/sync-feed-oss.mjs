/**
 * Mirror the locally staged rolling release (`dist-publish/`) to an Aliyun
 * OSS bucket — the cloud feed base for users GitHub cannot reach well
 * (domestic manufacturing sites). The layout is byte-identical to the
 * release assets, served under the bucket's `feed/` prefix while the website
 * occupies the bucket root, so one base URL serves the plugin feed
 * (`plugins.feedUrls`), the desktop update channel (`update.feedUrl` /
 * electron-builder `publish.url`) and direct installer downloads. OSS is
 * pure static hosting with no publish-side logic; all verification stays
 * client-side (sha256 per index entry, Ed25519 per zip).
 *
 * Run after a local assembly (publish --skip-sync / publish:local):
 *
 *   SNAP_RAIL_OSS_BUCKET=oss://<bucket> pnpm run feed:sync-oss
 *
 * The destination is `<bucket>/<prefix>/`; the prefix defaults to `feed`
 * (`SNAP_RAIL_OSS_PREFIX` overrides). A bare bucket root is refused unless
 * `SNAP_RAIL_OSS_ALLOW_ROOT=1` is set explicitly — `--delete` against the
 * root would wipe the website files that live beside the feed.
 *
 * Configuration (environment):
 *
 *   SNAP_RAIL_OSS_BUCKET    required — `oss://<bucket>[/<prefix>]`
 *   SNAP_RAIL_OSS_PREFIX    optional — default `feed` (ignored when the
 *                           bucket already carries a prefix)
 *   SNAP_RAIL_OSS_ENDPOINT  optional — e.g. oss-cn-hangzhou.aliyuncs.com
 *   SNAP_RAIL_OSS_AK_ID / SNAP_RAIL_OSS_AK_SECRET
 *                           optional — omit to use ossutil's own config
 *                           (`~/.ossutilconfig` or `-c` via SNAP_RAIL_OSS_CONFIG)
 *   SNAP_RAIL_OSS_CONFIG    optional — path to an ossutil config file
 *   SNAP_RAIL_OSSUTIL       optional — ossutil binary name (default `ossutil`;
 *                           Windows builds are often `ossutil64.exe`)
 *
 * The `plugins/assets/` screenshots stay local (website build input only,
 * matching what a Release would carry). Stale remote files are removed —
 * the bucket prefix is a rolling-release mirror, not an archive.
 *
 * @module snap-rail/scripts/sync-feed-oss
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(join(import.meta.dirname, '..'))
const stageDir = join(repoRoot, 'dist-publish')
const flatDir = join(stageDir, 'oss-flat')

const bucket = process.env.SNAP_RAIL_OSS_BUCKET
if (bucket === undefined || bucket === '') {
  throw new Error('sync-feed-oss: set SNAP_RAIL_OSS_BUCKET (e.g. oss://snap-rail-feed)')
}
/** Destination prefix: `oss://<bucket>/<prefix>/` — never the bare root
 * (the website lives there; `--delete` against the root would erase it). */
function destinationBase() {
  const trimmed = bucket.replace(/\/+$/, '')
  const withoutScheme = trimmed.replace(/^oss:\/\//, '')
  if (withoutScheme.includes('/')) return `${trimmed}/`
  if (process.env.SNAP_RAIL_OSS_ALLOW_ROOT === '1') {
    console.log('sync-feed-oss: SNAP_RAIL_OSS_ALLOW_ROOT=1 —— 明确要求同步到桶根（官网会被 --delete 清掉，慎用）')
    return `${trimmed}/`
  }
  const prefix = (process.env.SNAP_RAIL_OSS_PREFIX ?? 'feed').replace(/^\/+|\/+$/g, '')
  const destination = `${trimmed}/${prefix}/`
  console.log(`sync-feed-oss: SNAP_RAIL_OSS_BUCKET 未带前缀，默认同步到 ${destination}（改前缀用 SNAP_RAIL_OSS_PREFIX）`)
  return destination
}
const bucketBase = destinationBase()

if (!existsSync(join(stageDir, 'plugins', 'index.json'))) {
  throw new Error('sync-feed-oss: dist-publish/plugins/index.json 缺失 —— 先跑 `pnpm run publish:local` 装配')
}

/** Flatten plugins/ (minus assets/) + desktop/ into one directory. */
rmSync(flatDir, { recursive: true, force: true })
mkdirSync(flatDir, { recursive: true })
for (const entry of readdirSync(join(stageDir, 'plugins'), { withFileTypes: true })) {
  if (entry.name === 'assets') continue
  cpSync(join(stageDir, 'plugins', entry.name), join(flatDir, entry.name), { recursive: true })
}
if (existsSync(join(stageDir, 'desktop'))) {
  for (const entry of readdirSync(join(stageDir, 'desktop'), { withFileTypes: true })) {
    cpSync(join(stageDir, 'desktop', entry.name), join(flatDir, entry.name), { recursive: true })
  }
}

/** ossutil auth/endpoint flags; empty when the tool's own config is used. */
/** ossutil auth/endpoint flags; empty when the tool's own config is used.
 * Windows defaults to `ossutil64.exe`: the `ossutil` name often resolves to a
 * `.bat` wrapper that exits 0 without uploading — a silent no-op is the
 * worst possible failure for a deploy script. */
const ossutil = process.env.SNAP_RAIL_OSSUTIL ?? (process.platform === 'win32' ? 'ossutil64.exe' : 'ossutil')
const args = []
if (process.env.SNAP_RAIL_OSS_CONFIG !== undefined && process.env.SNAP_RAIL_OSS_CONFIG !== '') {
  args.push('-c', process.env.SNAP_RAIL_OSS_CONFIG)
}
if (process.env.SNAP_RAIL_OSS_ENDPOINT !== undefined && process.env.SNAP_RAIL_OSS_ENDPOINT !== '') {
  args.push('-e', process.env.SNAP_RAIL_OSS_ENDPOINT)
}
if (process.env.SNAP_RAIL_OSS_AK_ID !== undefined && process.env.SNAP_RAIL_OSS_AK_ID !== '') {
  args.push('-i', process.env.SNAP_RAIL_OSS_AK_ID, '-k', process.env.SNAP_RAIL_OSS_AK_SECRET ?? '')
}

const run = (label, command) => {
  console.log(`sync-feed-oss: ${label}`)
  const result = spawnSync(ossutil, [...args, ...command], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`sync-feed-oss: 无法运行 ${ossutil}（${result.error.message}）——请安装 ossutil 并加入 PATH，或用 SNAP_RAIL_OSSUTIL 指向可执行文件`)
  }
  if (result.status !== 0) {
    throw new Error(`sync-feed-oss: ossutil ${label} 失败（exit ${result.status}）`)
  }
}

/** CDN 默认遵循源站 Cache-Control：滚动源里清单类（index/catalog/latest）
 * 必须短缓存（新版本发布及时可见），zip/exe/blockmap 内容寻址、长缓存。
 * meta 值不含空格：Windows 下 spawnSync 走 shell 拼参，空格会拆散参数。
 * 实测 1.7.19：sync 会忽略 --meta，且 sync --delete 会把 cp 上传的对象
 * 当作不同而整组重传（无 meta）——所以顺序必须是：先 sync（上传+滚动
 * 清理），后 cp 按类型重写缓存头。匹配文件会双传一次（清单 KB 级、
 * 安装包 ~20s，可接受）。 */
const SHORT_CACHE = 'Cache-Control:public,max-age=300'
const LONG_CACHE = 'Cache-Control:public,max-age=2592000'
run(`sync 滚动上传与清理 → ${bucketBase}`, ['sync', flatDir, bucketBase, '--delete', '-f'])
run(`cp 清单（短缓存） → ${bucketBase}`, [
  'cp', '-r', '-f', '--meta', SHORT_CACHE,
  '--include', '*.json', '--include', '*.yml', flatDir, bucketBase,
])
run(`cp 安装包与插件 zip（长缓存） → ${bucketBase}`, [
  'cp', '-r', '-f', '--meta', LONG_CACHE,
  '--include', '*.zip', '--include', '*.exe', '--include', '*.blockmap', flatDir, bucketBase,
])
const prefixPath = bucketBase.replace(/^oss:\/\/[^/]+/, '')
console.log(`\nsync-feed-oss: 完成。基址 = https://<bucket 域名>${prefixPath}（公共读 Bucket 即桶默认域名）`)
console.log('验收：pnpm exec tsx scripts/check-feed-endpoint.ts --update <基址> --plugins <基址> --site https://<桶域名>/')
