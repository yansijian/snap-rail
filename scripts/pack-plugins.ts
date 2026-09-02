/**
 * Pack the installable plugin zips for a release: each package becomes one
 * final-format zip (manifest + built faces) under dist-plugins/, exactly
 * what the settings page's 安装插件 consumes — the same path the future
 * marketplace serves. Dev usage: `pnpm run pack:plugins` (build first).
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, type Zippable } from 'fflate'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The packages shipped as installable zips (name → relative dir). */
const PLUGIN_PACKAGES: ReadonlyArray<{ name: string, dir: string }> = [
  { name: '@snap-rail/suite-terminal-ops', dir: 'packages/suites/terminal-ops' },
  { name: '@snap-rail/driver-mock', dir: 'packages/field/driver-mock' },
  { name: '@snap-rail/driver-modbus', dir: 'packages/field/driver-modbus' },
]

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

/** Collect every file under `dir` (skipping node_modules and tsbuildinfo). */
async function collect(dir: string, base: string): Promise<Zippable> {
  const files: Zippable = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.endsWith('.tsbuildinfo')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, await collect(full, base))
      continue
    }
    const rel = relative(base, full).replaceAll('\\', '/')
    files[rel] = new Uint8Array(await readFile(full))
  }
  return files
}

async function main(): Promise<void> {
  const outDir = join(repoRoot, 'dist-plugins')
  await mkdir(outDir, { recursive: true })
  for (const plugin of PLUGIN_PACKAGES) {
    const base = join(repoRoot, plugin.dir)
    await stat(base)
    const zipName = `${plugin.name.replaceAll('/', '__')}.zip`
    const zipped = zipSync(await collect(base, base), { level: 9 })
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(join(outDir, zipName))
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.end(zipped)
    })
    console.log(`packed ${zipName} (${(zipped.length / 1024).toFixed(0)} KiB)`)
  }
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
