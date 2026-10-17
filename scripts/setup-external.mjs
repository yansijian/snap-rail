/**
 * Stage the split first-party plugin repositories the main build links
 * against into `external/` (gitignored). They are workspace packages, not
 * registry dependencies: `equipment-station` needs the framework's type/UI
 * surface and the modbus driver for its tests, and linking source keeps the
 * public build free of a private registry.
 *
 * Run before `pnpm install` (the workspace glob `external/*` is otherwise
 * empty):
 *
 *   node scripts/setup-external.mjs              # git clone from GitHub (ref: master)
 *   SNAP_RAIL_EXTERNAL_REF=v0.2.0 node scripts/setup-external.mjs
 *   SNAP_RAIL_EXTERNAL_LOCAL=1 node scripts/setup-external.mjs   # copy ../<repo>
 *   SNAP_RAIL_EXTERNAL_REPOS=a,b node scripts/setup-external.mjs # extra feed-only repos
 *
 * Existing checkouts are left alone; delete `external/<repo>` to refresh.
 *
 * @module snap-rail/scripts/setup-external
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(join(import.meta.dirname, '..'))
const destRoot = join(repoRoot, 'external')
const ref = process.env.SNAP_RAIL_EXTERNAL_REF ?? 'master'
const local = process.env.SNAP_RAIL_EXTERNAL_LOCAL === '1'

/**
 * The split repos the main workspace build depends on. The feed job widens
 * the list (suite + the second driver) because it packs every first-party
 * plugin from source; the app build only needs the framework and modbus.
 */
const REPOS = (process.env.SNAP_RAIL_EXTERNAL_REPOS
  ?? 'snap-rail-framework-shadcn,snap-rail-driver-modbus')
  .split(',')
  .map(repo => repo.trim())
  .filter(repo => repo !== '')

const SKIP = new Set(['node_modules', 'lib', 'lib-client', 'dist', '.git'])

/** Every package name the main workspace provides. */
function workspaceNames() {
  const names = new Set()
  const read = path => {
    try {
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string') names.add(manifest.name)
    } catch {
      // Not a package directory.
    }
  }
  for (const group of readdirSync(join(repoRoot, 'packages'))) {
    for (const pkg of readdirSync(join(repoRoot, 'packages', group))) read(join(repoRoot, 'packages', group, pkg))
  }
  for (const pkg of readdirSync(join(repoRoot, 'vendor'))) read(join(repoRoot, 'vendor', pkg))
  return names
}

/**
 * A split repo's manifest may pin registry ranges for packages the main
 * workspace provides (the SDK moved to 0.2, for example). As a workspace
 * package it must link the local copy instead — no registry is reachable in
 * a public build. This only rewrites the staged (gitignored) checkout.
 */
function linkWorkspaceDeps(target, names) {
  const path = join(target, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  for (const field of ['dependencies', 'devDependencies']) {
    const block = manifest[field]
    if (block === undefined || block === null) continue
    for (const name of Object.keys(block)) {
      if (names.has(name)) block[name] = 'workspace:*'
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

const names = workspaceNames()

for (const repo of REPOS) {
  const target = join(destRoot, repo)
  if (existsSync(join(target, 'package.json'))) {
    linkWorkspaceDeps(target, names)
    console.log(`setup-external: ${repo} already staged`)
    continue
  }
  mkdirSync(destRoot, { recursive: true })
  const sibling = join(repoRoot, '..', repo)
  if (local && existsSync(join(sibling, 'package.json'))) {
    cpSync(sibling, target, {
      recursive: true,
      filter: source => !SKIP.has(source.slice(sibling.length + 1).split(/[\\/]/)[0] ?? ''),
    })
    console.log(`setup-external: copied ${sibling} → ${target}`)
    linkWorkspaceDeps(target, names)
    continue
  }
  const url = process.env.SNAP_RAIL_EXTERNAL_BASE === undefined
    ? `https://github.com/yansijian/${repo}.git`
    : `${process.env.SNAP_RAIL_EXTERNAL_BASE.replace(/\/+$/, '')}/${repo}.git`
  console.log(`setup-external: cloning ${url} (${ref})`)
  execFileSync('git', ['clone', '--depth', '1', '--branch', ref, url, target], { stdio: 'inherit' })
  linkWorkspaceDeps(target, names)
}
