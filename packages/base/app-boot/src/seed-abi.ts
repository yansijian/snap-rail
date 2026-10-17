/**
 * The host side of the seed-ABI handshake: read the app's own dependency
 * tree for the base-package versions behind every seed id, producing the
 * live table the renderer boot and the installer compare a client face's
 * stamped declaration against. Node-only — the renderer receives the table
 * over the wire (`client-config.list`), it never resolves packages itself.
 *
 * @module @snap-rail/app-boot/seed-abi
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { SEED_ABI_REVISION, SEED_MODULES, type SeedAbi } from '@snap-rail/plugin-kit/seeds'

/** The base npm package of a seed id (`react/jsx-runtime` → `react`;
 * `@scope/name/sub` → `@scope/name`). */
function basePackageOf(seedId: string): string {
  const parts = seedId.split('/')
  return seedId.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Resolved tables by app root — the tree's versions are immutable for the
 * app's lifetime, so every `client-config.list` shares one resolution. */
const resolved = new Map<string, Promise<SeedAbi>>()

/**
 * Resolve the live seed table from `appRoot`'s dependency tree: one version
 * per seed id whose base package resolves from there (dev = the workspace,
 * packaged = the shipped node_modules). Ids that do not resolve are simply
 * absent — the comparison covers the declared∩live intersection, so an
 * absent host version never fails a face by itself. A missing appRoot (test
 * worlds, odd hosts) yields the revision with an empty table — the
 * handshake degrades to revision-equality only. Results are memoized per
 * appRoot: resolution is fs-bound and the table cannot change while the
 * process lives.
 *
 * @param appRoot - the application root directory (`app.getAppPath()`).
 */
export function resolveSeedAbi(appRoot: string | undefined): Promise<SeedAbi> {
  const key = appRoot === undefined || appRoot === '' ? '' : appRoot
  let table = resolved.get(key)
  if (table === undefined) {
    table = resolveSeedAbiUncached(appRoot)
    resolved.set(key, table)
  }
  return table
}

async function resolveSeedAbiUncached(appRoot: string | undefined): Promise<SeedAbi> {
  if (appRoot === undefined || appRoot === '') return { revision: SEED_ABI_REVISION, versions: {} }
  const versions: Record<string, string> = {}
  try {
    const require = createRequire(join(appRoot, 'package.json'))
    for (const seedId of SEED_MODULES) {
      try {
        const manifestPath = require.resolve(`${basePackageOf(seedId)}/package.json`)
        const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version !== '') versions[seedId] = parsed.version
      } catch {
        // Not resolvable from this app tree — leave the id out of the table.
      }
    }
  } catch {
    // An unreadable app tree must never take the wire down — revision only.
  }
  return { revision: SEED_ABI_REVISION, versions }
}
