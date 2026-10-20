/**
 * Publish the built website (`website/dist`) to the OSS bucket root — the
 * domestic home of the site (the feed lives under the bucket's `feed/`
 * prefix and this script never touches it).
 *
 *   SNAP_RAIL_OSS_BUCKET=oss://<bucket> pnpm run site:sync-oss
 *
 * Safety rules:
 * - **never `--delete`**: a delete against the bucket root would treat the
 *   `feed/` prefix as "extra" and wipe the rolling release. Site entry files
 *   are stable names and always overwrite; rebuilt sites only accumulate a
 *   bounded amount of stale hashed assets, which is the accepted trade;
 * - a `website/dist` that contains a `feed/` directory is rejected outright,
 *   so site content can never be mistaken for (or overwrite) feed content;
 * - the OSS default domain forces `Content-Disposition: attachment` on HTML
 *   (ICP policy) — the site becomes browsable only after the 备案'd custom
 *   domain is bound (see docs/deploy.md「备案与域名绑定」).
 *
 * Same ossutil configuration surface as `sync-feed-oss.mjs`:
 *   SNAP_RAIL_OSS_BUCKET (required), SNAP_RAIL_OSS_ENDPOINT,
 *   SNAP_RAIL_OSS_AK_ID / SNAP_RAIL_OSS_AK_SECRET, SNAP_RAIL_OSS_CONFIG,
 *   SNAP_RAIL_OSSUTIL.
 *
 * @module snap-rail/scripts/sync-site-oss
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(join(import.meta.dirname, '..'))
const distDir = join(repoRoot, 'website', 'dist')

const bucket = process.env.SNAP_RAIL_OSS_BUCKET
if (bucket === undefined || bucket === '') {
  throw new Error('sync-site-oss: set SNAP_RAIL_OSS_BUCKET (e.g. oss://snap-rail-feed)')
}
const trimmed = bucket.replace(/\/+$/, '')
const withoutScheme = trimmed.replace(/^oss:\/\//, '')
if (withoutScheme.includes('/')) {
  throw new Error(`sync-site-oss: ${bucket} 带了前缀 —— 官网同步固定写桶根（feed 前缀归 feed:sync-oss）`)
}
const bucketRoot = `${trimmed}/`

if (!existsSync(join(distDir, 'index.html'))) {
  throw new Error('sync-site-oss: website/dist/index.html 缺失 —— 先跑 `pnpm run site:build`')
}
if (existsSync(join(distDir, 'feed'))) {
  throw new Error('sync-site-oss: website/dist 里出现 feed/ 目录 —— 这不是官网内容，拒绝同步')
}

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

console.log(`sync-site-oss: sync ${distDir} → ${bucketRoot}（不删除——feed/ 前缀在桶根之下，本脚本永不 delete）`)
const result = spawnSync(ossutil, [...args, 'sync', distDir, bucketRoot, '-f'], { stdio: 'inherit', shell: process.platform === 'win32' })
if (result.error !== undefined && result.error !== null) {
  throw new Error(`sync-site-oss: 无法运行 ${ossutil}（${result.error.message}）——用 SNAP_RAIL_OSSUTIL 指向可执行文件`)
}
if (result.status !== 0) {
  throw new Error(`sync-site-oss: ossutil 同步失败（exit ${result.status}）`)
}
console.log('\nsync-site-oss: 完成（桶根若有历史残留的哈希旧资源会保留，可手动清理，勿动 feed/ 前缀）。')
console.log('验收（备案后自定义域名才能内联浏览）：pnpm exec tsx scripts/check-feed-endpoint.ts --site https://<桶域名>/')
