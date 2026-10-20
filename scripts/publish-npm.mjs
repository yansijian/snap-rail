/**
 * Publish the public authoring closure (@snap-rail/*) to npm — the packages
 * an independent plugin repository needs; everything else stays app-internal.
 *
 *   node scripts/publish-npm.mjs             # CI (needs NODE_AUTH_TOKEN)
 *   node scripts/publish-npm.mjs --dry-run   # local preview, writes nothing
 *
 * Idempotent per version: a package whose name@version already exists on the
 * registry is skipped, so re-running after a partial failure converges.
 *
 * Publish-time peer filtering: every package's `peerDependencies` is stripped
 * to peers this closure (or the public third-party allowlist) actually
 * satisfies. pnpm's `auto-install-peers` installs missing peers even optional
 * ones, so a published manifest that peers on an app-internal package would
 * break every external install with E404. The filter runs on a copy of the
 * manifest in CI's disposable workspace; the source repositories keep their
 * in-workspace declarations.
 *
 * @module snap-rail/scripts/publish-npm
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

/** The closure, in dependency order (consumers after their dependencies). */
const closure = [
  'vendor/cosmokit',
  'vendor/cordis',
  'packages/base/util',
  'packages/base/protocol',
  'packages/base/plugin-kit',
  'packages/base/plugin-sdk',
  'packages/store/store',
  'packages/equipment/equipment',
  // The UI framework: first npm publication; lives in its split repo and is
  // staged into the workspace by scripts/setup-external.mjs (prepare-workspace
  // builds its faces before this script runs).
  'external/snap-rail-framework-shadcn',
]

/** Peers the published closure itself satisfies, plus third-party packages
 * that are public on npm. Anything else is stripped at publish time. */
const publicPeers = new Set([
  '@snap-rail/cosmokit',
  '@snap-rail/cordis',
  '@snap-rail/util',
  '@snap-rail/protocol',
  '@snap-rail/plugin-kit',
  '@snap-rail/plugin-sdk',
  '@snap-rail/store',
  '@snap-rail/equipment',
  '@snap-rail/framework-shadcn',
  'drizzle-orm',
  'react',
  'react-dom',
  'tsdown',
  'zod',
])

function dirname(path) {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: repoRoot,
    ...options,
  })
  return result.status === 0
}

function npmView(pkg) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['view', pkg, 'version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

for (const dir of closure) {
  const manifestPath = join(repoRoot, dir, 'package.json')
  const source = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(source)
  const { name, version } = manifest
  const existing = npmView(`${name}@${version}`)
  if (existing !== undefined) {
    console.log(`skip ${name}@${version} (already published)`)
    continue
  }

  // Publish-time peer filter (see module doc): drop peers nothing public
  // satisfies, plus their peerDependenciesMeta leftovers.
  const peers = manifest.peerDependencies
  if (peers !== undefined && typeof peers === 'object') {
    const dropped = Object.keys(peers).filter(peer => !publicPeers.has(peer))
    if (dropped.length > 0) {
      for (const peer of dropped) delete peers[peer]
      if (manifest.peerDependenciesMeta !== undefined && typeof manifest.peerDependenciesMeta === 'object') {
        for (const peer of dropped) delete manifest.peerDependenciesMeta[peer]
        if (Object.keys(manifest.peerDependenciesMeta).length === 0) delete manifest.peerDependenciesMeta
      }
      if (Object.keys(peers).length === 0) delete manifest.peerDependencies
      console.log(`filter ${name}: dropping unpublished peers (${dropped.join(', ')})`)
      if (!dryRun) {
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      }
    }
  }

  console.log(`publishing ${name}@${version}`)
  if (dryRun) continue
  if (!run('pnpm', ['publish', '--access', 'public', '--no-git-checks'], { cwd: join(repoRoot, dir) })) {
    throw new Error(`publish-npm: ${name}@${version} 发布失败`)
  }
}

console.log(`publish-npm: ${dryRun ? 'dry-run 完成' : '闭包发布完成'}（${closure.length} packages）`)
