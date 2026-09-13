/**
 * Install the packed first-party catalog into a snap-rail home — the CLI
 * twin of the settings page's 安装插件 flow, dogfooding the exact installer
 * pipeline (zip → inspect-extracted pool package → user-layer rows).
 * Existing rows keep their state; each packed package lands enabled unless
 * a row already exists. Run after packing:
 * `pnpm run build && pnpm run pack:plugins && pnpm exec tsx scripts/install-dev-plugins.ts <home>`
 *
 * @module snap-rail/scripts/install-dev-plugins
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { installPluginFromZip, uninstallPlugin } from '../packages/base/app-boot/src/installer.ts'

/** Rows this catalog enables (subpath rows ride their package). */
const CATALOG_ROWS: readonly string[] = [
  '@snap-rail/store-sqlite',
  '@snap-rail/equipment',
  '@snap-rail/equipment/rpc',
  '@snap-rail/driver-modbus',
  '@snap-rail/driver-enip',
  '@snap-rail/framework-shadcn',
  '@snap-rail/settings-station',
  '@snap-rail/equipment-station',
  '@snap-rail/trend',
  '@snap-rail/forge',
  '@snap-rail/suite-terminal-ops',
]

interface UserRow {
  name: string
  enabled?: boolean
  config?: unknown
}

function main(): void {
  const home = process.argv[2]
  if (home === undefined || !existsSync(home)) {
    console.error('usage: tsx scripts/install-dev-plugins.ts <snap-rail home dir>')
    process.exitCode = 1
    return
  }
  const repoRoot = join(import.meta.dirname, '..')
  const distPlugins = join(repoRoot, 'dist-plugins')
  const poolDir = join(home, 'plugins')
  const userLayerPath = join(home, 'plugins.yml')

  const installed: string[] = []
  for (const file of readdirSync(distPlugins)) {
    if (!file.endsWith('.zip')) continue
    const name = file.slice(0, -'.zip'.length).replaceAll('__', '/')
    // Idempotence: an existing pool copy is replaced (uninstall first —
    // the UI flow demands a manual uninstall, a dev loop must not).
    try {
      uninstallPlugin(name, poolDir, home)
    } catch {
      // Not installed yet — the normal first run.
    }
    installPluginFromZip(join(distPlugins, file), poolDir)
    installed.push(name)
  }

  let rows: UserRow[] = []
  if (existsSync(userLayerPath)) {
    const parsed = load(readFileSync(userLayerPath, 'utf8')) as { plugins?: UserRow[] } | undefined
    rows = parsed?.plugins ?? []
  }
  for (const name of CATALOG_ROWS) {
    if (rows.some(row => row.name === name)) continue
    rows.push({ name, enabled: true })
  }
  writeFileSync(userLayerPath, dump({ plugins: rows }))
  console.log(`installed ${installed.length} packages into ${poolDir}`)
  console.log(`user layer now lists ${rows.length} rows at ${userLayerPath}`)
  console.log('renderer rows take effect on the next app start')
}

main()
