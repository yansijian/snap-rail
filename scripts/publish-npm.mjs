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
 * Registry isolation: split plugin repos (external/*) carry a repo-level
 * `.npmrc` pinning `@snap-rail:*` to the owner's intranet npm registry. That
 * config is neutralized for the publish call — this closure always publishes
 * to registry.npmjs.org.
 *
 * @module snap-rail/scripts/publish-npm
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  // The OS integration seam: the framework (and any UI package that drives the
  // ball/panel surfaces) imports `@snap-rail/shell/contract`, so the spec
  // package publishes before the kit that lists it as a seed.
  'packages/base/shell',
  'packages/base/plugin-kit',
  'packages/base/plugin-sdk',
  'packages/store/store',
  'packages/equipment/equipment',
  // The UI framework: first npm publication; lives in its split repo and is
  // staged into the workspace by scripts/setup-external.mjs (prepare-workspace
  // builds its faces before this script runs).
  'external/snap-rail-framework-shadcn',
]

/** Third-party peers that are themselves public on npm. Closure package names
 * are added from the manifests below — deriving them keeps the allowlist from
 * drifting when the closure grows. Anything else is stripped at publish time. */
const PUBLIC_THIRD_PARTY_PEERS = [
  'drizzle-orm',
  'react',
  'react-dom',
  'tsdown',
  'zod',
]

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
  // The closure always publishes to public npm; existence checks must ask the
  // same registry. A developer-local npmmirror would otherwise report a
  // lagging package as missing (or a mirror-only version as present) and
  // break idempotence.
  const result = spawnSync(npm, ['view', pkg, 'version', '--registry', 'https://registry.npmjs.org/'], { encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

const entries = closure.map(dir => {
  const manifestPath = join(repoRoot, dir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`publish-npm: 缺少 ${dir}/package.json —— 先跑 node scripts/setup-external.mjs`)
  }
  const source = readFileSync(manifestPath, 'utf8')
  return { dir, manifestPath, source, manifest: JSON.parse(source) }
})
const publicPeers = new Set([...entries.map(entry => entry.manifest.name), ...PUBLIC_THIRD_PARTY_PEERS])

for (const entry of entries) {
  const { dir, manifestPath, source, manifest } = entry
  const { name, version } = manifest
  const existing = npmView(`${name}@${version}`)
  if (existing !== undefined) {
    console.log(`skip ${name}@${version} (already published)`)
    continue
  }

  // Publish-time peer filter (see module doc): drop peers nothing public
  // satisfies, plus their peerDependenciesMeta leftovers. The rewrite exists
  // only for the publish call; the source file is restored in `finally` so a
  // local (non-CI) run never leaves stripped peers in the working tree.
  let manifestRewritten = false
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
        manifestRewritten = true
      }
    }
  }

  console.log(`publishing ${name}@${version}`)
  if (dryRun) continue
  // The split plugin repos carry a repo-level `.npmrc` pinning `@snap-rail:*`
  // to the owner's intranet npm registry (their own publishing model). A
  // `pnpm publish` inside such a directory inherits the scoped mapping and
  // would post the package to an address a CI runner cannot reach — this
  // closure publishes to public npm only. Neutralize the dir-local config
  // for the publish call (the clone is disposable; restored afterwards).
  const localNpmrc = join(repoRoot, dir, '.npmrc')
  const standbyNpmrc = `${localNpmrc}.publish-standby`
  const npmrcHidden = existsSync(localNpmrc)
  if (npmrcHidden) {
    renameSync(localNpmrc, standbyNpmrc)
    console.log(`neutralize ${name}: repo .npmrc pinned a private registry — publishing to public npm instead`)
  }
  try {
    if (!run('pnpm', ['publish', '--access', 'public', '--no-git-checks', '--registry', 'https://registry.npmjs.org/'], { cwd: join(repoRoot, dir) })) {
      throw new Error(`publish-npm: ${name}@${version} 发布失败`)
    }
  } finally {
    if (manifestRewritten) writeFileSync(manifestPath, source)
    if (npmrcHidden) renameSync(standbyNpmrc, localNpmrc)
  }
}

console.log(`publish-npm: ${dryRun ? 'dry-run 完成' : '闭包发布完成'}（${closure.length} packages）`)
