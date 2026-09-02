/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) under dist-plugins/ — exactly what the settings page's 安装插件
 * consumes and the same shape the future marketplace serves. The assembly
 * rules live in `@snap-rail/plugin-kit/pack`; this is only the repo's
 * shipment list. Run a build first: `pnpm run build && pnpm run pack:plugins`.
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { releaseFiles, zipFileName, type ReleaseSpec } from '@snap-rail/plugin-kit/pack'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The packages shipped as installable zips. */
const PLUGIN_PACKAGES: readonly ReleaseSpec[] = [
  {
    name: '@snap-rail/suite-terminal-ops',
    dir: join(repoRoot, 'packages/suites/terminal-ops'),
    hostDir: 'lib',
    hostFace: 'lib/stats.js',
    clientFace: 'lib-client',
  },
  {
    name: '@snap-rail/driver-mock',
    dir: join(repoRoot, 'packages/field/driver-mock'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
  },
  {
    name: '@snap-rail/driver-modbus',
    dir: join(repoRoot, 'packages/field/driver-modbus'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
  },
]

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

async function main(): Promise<void> {
  const outDir = join(repoRoot, 'dist-plugins')
  await mkdir(outDir, { recursive: true })
  for (const spec of PLUGIN_PACKAGES) {
    const files = await releaseFiles(spec)
    const zipped = zipSync(files, { level: 9 })
    const target = join(outDir, zipFileName(spec.name))
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target)
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.end(zipped)
    })
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
