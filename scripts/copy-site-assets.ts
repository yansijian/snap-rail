/**
 * Catalog asset copier for the website build: the publish pipeline stages
 * combo and plugin screenshots under `dist-publish/plugins/assets/`, and the
 * generated catalog references them as `./site-assets/...`. This copies the
 * staged tree into the website's static public dir so Vite ships it beside
 * the pages. A missing source (no screenshots yet) is a no-op.
 *
 * It also ships the plugin-development doc itself as a public file
 * (`/plugin-development.md`): before the 备案'd domain is bound, the OSS
 * default domain forces HTML downloads and `dev.html` needs its asset
 * siblings, so the raw markdown is the only doc URL that works as a direct
 * download. Single source stays `docs/plugin-development.md` — this is a
 * build-time copy, gitignored in `public/`.
 *
 * @module snap-rail/scripts/copy-site-assets
 */

import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'dist-publish', 'plugins', 'assets')
const target = join(repoRoot, 'website', 'public', 'site-assets')
const docSource = join(repoRoot, 'docs', 'plugin-development.md')
const docTarget = join(repoRoot, 'website', 'public', 'plugin-development.md')

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

if (existsSync(docSource)) {
  cpSync(docSource, docTarget)
  console.log(`copy-site-assets: ${docSource} → ${docTarget}`)
}
