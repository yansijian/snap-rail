/**
 * Catalog asset copier for the website build: the publish pipeline stages
 * combo and plugin screenshots under `dist-publish/plugins/assets/`, and the
 * generated catalog references them as `./site-assets/...`. This copies the
 * staged tree into the website's static public dir so Vite ships it beside
 * the pages. A missing source (no screenshots yet) is a no-op.
 *
 * @module snap-rail/scripts/copy-site-assets
 */

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'dist-publish', 'plugins', 'assets')
const target = join(repoRoot, 'website', 'public', 'site-assets')

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

if (!existsSync(source)) {
  console.log('copy-site-assets: no staged assets — skipping')
} else {
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  console.log(`copy-site-assets: ${source} → ${target}`)
}
