/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) plus an `index.json` catalog — exactly what the settings page's
 * 安装插件 consumes locally and what the 插件市场 feed serves remotely.
 * The assembly rules live in `@snap-rail/plugin-kit/pack`; this is only the
 * repo's shipment list. Run a build first: `pnpm run build && pnpm run pack:plugins`.
 *
 * Output lands in `dist-plugins/` by default; pass `--out <dir>` to pack
 * straight into a feed directory (e.g. an nginx docroot).
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  {
    name: '@snap-rail/forge',
    dir: join(repoRoot, 'packages/tools/forge'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    clientFace: 'lib-client',
  },
  {
    name: '@snap-rail/trend',
    dir: join(repoRoot, 'packages/tools/trend'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    clientFace: 'lib-client',
  },
]

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

/** The `--out <dir>` CLI override; defaults to the repo's dist-plugins/. */
function outDirArg(): string {
  const index = process.argv.indexOf('--out')
  if (index < 0) return join(repoRoot, 'dist-plugins')
  const value = process.argv[index + 1]
  if (value === undefined || value === '') {
    throw new Error('pack-plugins: --out requires a directory argument')
  }
  return resolve(value)
}

async function main(): Promise<void> {
  const outDir = outDirArg()
  await mkdir(outDir, { recursive: true })
  const entries: Array<Record<string, unknown>> = []
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
    // The catalog entry reads back out of the shipped release manifest, so
    // the feed can never advertise something the zip does not carry.
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as {
      version?: string
      description?: string
      snapRail?: { kind?: string }
    }
    entries.push({
      name: spec.name,
      version: manifest.version ?? '0.0.0',
      ...(manifest.description !== undefined && manifest.description !== '' ? { description: manifest.description } : {}),
      ...(manifest.snapRail?.kind !== undefined ? { kind: manifest.snapRail.kind } : {}),
      file: zipFileName(spec.name),
    })
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
  const catalog = `${JSON.stringify({ plugins: entries }, null, 2)}\n`
  await writeFile(join(outDir, 'index.json'), catalog, 'utf8')
  console.log(`packed index.json (${entries.length} plugins)`)
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
