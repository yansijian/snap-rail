/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) plus an `index.json` catalog — exactly what the settings page's
 * 安装插件 consumes locally and what a static plugin feed serves remotely.
 * The assembly rules live in `@snap-rail/plugin-kit/pack`; this is only the
 * repo's shipment list. Run a build first, then provide the publisher key:
 * `pnpm run build && pnpm run pack:plugins -- --sign-key .keys/release.private.pem --key-id release-2026`.
 *
 * Output lands in `dist-plugins/` by default; pass `--out <dir>` to pack
 * straight into a feed directory (e.g. an nginx docroot).
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createPrivateKey } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { releaseFiles, zipFileName, type ReleaseSpec } from '@snap-rail/plugin-kit/pack'
import { signReleaseFiles } from '@snap-rail/plugin-kit/sign'
import { catalogEntryFromZip } from './lib/catalog-entry.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The packages shipped as installable zips — the base catalog. The publish
 * pipeline reuses the list to enrich `catalog.json` from the repo sources
 * (author, repository, readme), so it lives here: the shipment list has
 * exactly one home. It is **empty on purpose**: store-sqlite, equipment, the
 * equipment-station page library and the whole UI substrate are built-in
 * defaults since the UI refactor, and a zip sharing a built-in name is refused
 * at install. Everything installable — drivers, extra skins, business pages,
 * suites — lives in its own repository and reaches the feed through the
 * collect pipeline (docs/split-runbook.md). */
export const PLUGIN_PACKAGES: readonly ReleaseSpec[] = []

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

interface SigningOptions {
  keyId: string
  privateKey: ReturnType<typeof createPrivateKey>
  publisher?: string
}

/** Release signing is mandatory for every installable feed artifact. */
function signingOptions(): SigningOptions {
  const keyPathIndex = process.argv.indexOf('--sign-key')
  const keyIdIndex = process.argv.indexOf('--key-id')
  const keyPath = keyPathIndex >= 0 ? process.argv[keyPathIndex + 1] : undefined
  const keyId = keyIdIndex >= 0 ? process.argv[keyIdIndex + 1] : undefined
  if (keyPath === undefined && keyId === undefined) {
    throw new Error('pack-plugins: releases must be signed; pass --sign-key <private.pem> and --key-id <id>')
  }
  if (keyPath === undefined || keyId === undefined || keyPath === '' || keyId === '') {
    throw new Error('pack-plugins: --sign-key and --key-id must be supplied together')
  }
  const publisherIndex = process.argv.indexOf('--publisher')
  const publisher = publisherIndex >= 0 ? process.argv[publisherIndex + 1] : undefined
  return {
    keyId,
    privateKey: createPrivateKey(readFileSync(resolve(keyPath))),
    ...(publisher === undefined || publisher === '' ? {} : { publisher }),
  }
}

async function main(): Promise<void> {
  const outDir = outDirArg()
  const signing = signingOptions()
  await mkdir(outDir, { recursive: true })
  // The dist directory is a pure build output: stale zips from retired
  // packages must never ride the next install or publish.
  for (const entry of await readdir(outDir)) {
    if (entry.endsWith('.zip') || entry === 'index.json' || entry === 'catalog.json') {
      await rm(join(outDir, entry), { force: true })
    }
  }
  const entries: Array<Record<string, unknown>> = []
  for (const spec of PLUGIN_PACKAGES) {
    const unsignedFiles = await releaseFiles(spec)
    const sourceManifest = JSON.parse(new TextDecoder().decode(unsignedFiles['package.json']!)) as { name?: string, version?: string }
    const files = signReleaseFiles(unsignedFiles, {
      name: sourceManifest.name ?? spec.name,
      version: sourceManifest.version ?? '0.0.0',
      keyId: signing.keyId,
      privateKey: signing.privateKey,
      ...(signing.publisher === undefined ? {} : { publisher: signing.publisher }),
    })
    const zipped = zipSync(files, { level: 9 })
    const target = join(outDir, zipFileName(spec.name))
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target)
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.end(zipped)
    })
    // The catalog entry reads back out of the shipped zip bytes — the one
    // emitter shared with the collect pipeline; the digest covers the exact
    // bytes the client downloads and verifies before the installer runs.
    entries.push(catalogEntryFromZip(zipped, zipFileName(spec.name), spec.name, { requireSignature: true }))
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
  const catalog = `${JSON.stringify({ plugins: entries }, null, 2)}\n`
  await writeFile(join(outDir, 'index.json'), catalog, 'utf8')
  console.log(`packed index.json (${entries.length} plugins)`)
}

// Run only when invoked directly — the publish pipeline imports the
// shipment list and must not trigger a pack as a side effect.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(cause => {
    console.error(cause)
    process.exitCode = 1
  })
}
