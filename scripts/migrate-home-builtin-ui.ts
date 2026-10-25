/**
 * One-time home migration CLI for the built-in UI substrate — the manual twin
 * of the migration the host runs before composition at boot. Drops the pool
 * rows the framework-era installs left behind (`@snap-rail/framework-shadcn`,
 * the old clientOnly `@snap-rail/equipment-station`), rewrites `plugins.yml`
 * and `presets/*.yml`, and removes the dead pool copies. Safe to run
 * repeatedly; a clean home is untouched.
 *
 * Usage: pnpm exec tsx scripts/migrate-home-builtin-ui.ts <snap-rail home dir>
 *
 * @module snap-rail/scripts/migrate-home-builtin-ui
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { migrateRetiredUiHome } from '../packages/base/app-boot/src/migrate.ts'

function main(): void {
  const home = process.argv[2]
  if (home === undefined || !existsSync(home)) {
    console.error('usage: tsx scripts/migrate-home-builtin-ui.ts <snap-rail home dir>')
    process.exitCode = 1
    return
  }
  const result = migrateRetiredUiHome({
    presetDirs: [join(home, 'presets')],
    userLayerPath: join(home, 'plugins.yml'),
    poolDirs: [join(home, 'plugins')],
    log: message => console.log(message),
  })
  console.log(
    `removed ${result.removedRows} retired row(s) from ${result.rewrittenFiles.length} file(s); `
    + `removed ${result.removedPoolPackages.length} pool package(s)`,
  )
}

main()