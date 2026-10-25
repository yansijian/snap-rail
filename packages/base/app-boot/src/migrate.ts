/**
 * Home migration for the built-in UI substrate. The UI refactor made
 * `@snap-rail/framework-shadcn` and the old clientOnly
 * `@snap-rail/equipment-station` unloadable: `@snap-rail/ui` (base seed) now
 * supplies the semantic substrate, the default skin, the settings pages and
 * the 设备管理 page library. A leftover row would fail composition — the
 * file-interface rule is fail-loud, not a compatibility bridge — so the host
 * rewrites the app-managed preset files and the user layer before composing,
 * and removes the pool copies whose client faces predate the current seed ABI.
 *
 * The migration is idempotent and never touches anything else: a clean home
 * produces no writes. It deliberately runs at boot instead of hot-apply time:
 * combos installed after this version never write retired names, while a home
 * upgrading from the framework era does.
 *
 * @module @snap-rail/app-boot/migrate
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

/** Pool packages the built-in UI substrate replaces. */
export const RETIRED_UI_PACKAGES = [
  '@snap-rail/framework-shadcn',
  '@snap-rail/equipment-station',
] as const

/** Options of {@link migrateRetiredUiHome}. */
export interface RetiredUiMigrationOptions {
  /** Preset directories stacked before the user layer (see `boot`). */
  presetDirs: readonly string[]
  /** Absolute path of the user layer (`plugins.yml`); may not exist. */
  userLayerPath: string
  /** Plugin pool directories; retired packages are removed from them. */
  poolDirs: readonly string[]
  /** Diagnostic sink; defaults to a no-op (boot passes `console.warn`). */
  log?: (message: string) => void
}

/** What one migration run changed. */
export interface RetiredUiMigrationResult {
  /** Rows dropped across the preset files and the user layer. */
  removedRows: number
  /** Layer files that had to be rewritten. */
  rewrittenFiles: readonly string[]
  /** Pool packages whose directories were removed. */
  removedPoolPackages: readonly string[]
}

/**
 * Drop retired UI rows from the home's layer files and delete their pool
 * copies. Called by {@link boot} before the layers are read; safe to call
 * repeatedly.
 *
 * @param options - the home's preset directories, user layer and pool dirs.
 * @returns what the run changed (empty on a clean home).
 */
export function migrateRetiredUiHome(options: RetiredUiMigrationOptions): RetiredUiMigrationResult {
  const retired = new Set<string>(RETIRED_UI_PACKAGES)
  const log = options.log ?? (() => {})
  const rewrittenFiles: string[] = []
  let removedRows = 0

  const migrateLayerFile = (path: string): void => {
    if (!existsSync(path)) return
    let document: unknown
    try {
      document = load(readFileSync(path, 'utf8'))
    } catch {
      // Broken YAML stays fail-loud at load time; never rewrite it blind.
      return
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return
    const rows = (document as { plugins?: unknown }).plugins
    if (!Array.isArray(rows)) return
    const kept = rows.filter(row => !(
      row !== null
      && typeof row === 'object'
      && retired.has(String((row as { name?: unknown }).name))
    ))
    const dropped = rows.length - kept.length
    if (dropped === 0) return
    ;(document as { plugins: unknown }).plugins = kept
    writeFileSync(path, dump(document))
    removedRows += dropped
    rewrittenFiles.push(path)
    log(`snap-rail: removed ${dropped} retired UI row(s) from ${path}`)
  }

  for (const dir of options.presetDirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(name => name.endsWith('.yml') || name.endsWith('.yaml')).sort()) {
      migrateLayerFile(join(dir, file))
    }
  }
  migrateLayerFile(options.userLayerPath)

  // The retired zips can never load again (their client faces predate the
  // current seed ABI), so their pool directories are dead weight that would
  // keep reporting ABI refusals on every boot.
  const removedPoolPackages: string[] = []
  for (const poolDir of options.poolDirs) {
    for (const name of RETIRED_UI_PACKAGES) {
      const dir = join(poolDir, name.replaceAll('/', '__'))
      if (!existsSync(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removedPoolPackages.push(name)
      log(`snap-rail: removed retired pool package ${name}`)
    }
  }

  return { removedRows, rewrittenFiles, removedPoolPackages }
}