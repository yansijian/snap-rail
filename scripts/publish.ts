/**
 * One-command release pipeline: build the repo, pack the plugin feed,
 * assemble the recipe catalog and the website catalog, build the site, and
 * sync the three static artifacts to the server. The server stays logic-free
 * (docs/deploy.md) — everything here produces plain files under
 * `dist-publish/` first, so a release can be inspected before it syncs:
 *
 *   dist-publish/plugins/   ← index.json + recipes.json + catalog.json + zips + recipe docs (+ assets)
 *   dist-publish/site/      ← the built website (the server's web root)
 *   dist-publish/desktop/   ← latest.yml + setup exe + blockmap (when release-out has them)
 *
 * Usage: `pnpm run publish -- --sign-key <private.pem> --key-id <id> [--publisher <name>] [--skip-sync] [--market <dir>]`
 *   --skip-sync   stage only; nothing leaves the machine.
 *   --market <dir>  merge a second feed's index.json/zips (the snap-rail-market
 *     repo's pack output) into the catalog — community packages ride the same feed.
 *
 * Configuration lives in `deploy.config.json` (gitignored;
 * `deploy.config.example.json` is the template): the ssh target and the three
 * remote paths. The plugins/desktop remote directories are wiped on every
 * publish — they must be dedicated to snap-rail; the site root is extracted
 * over (stale hashed assets stay, harmless and cache-friendly).
 *
 * @module snap-rail/scripts/publish
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'
import { PLUGIN_PACKAGES } from './pack-plugins.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stageDir = join(repoRoot, 'dist-publish')

/** The recipes catalog entry as `recipes.json` serves it (the client-side schema lives in @snap-rail/app-boot/contract). */
interface RecipeCatalogEntry {
  id: string
  version: string
  title: string
  description?: string
  kind: 'base' | 'scenario'
  file: string
}

/** One source recipe directory: `recipes/<id>/recipe.yml` + `readme.md` (+ `assets/`). */
interface RecipeSource {
  id: string
  meta: {
    version?: unknown
    title?: unknown
    kind?: unknown
    description?: unknown
    plugins?: unknown
  }
  readme: string
  dir: string
}

interface DeployConfig {
  sshTarget: string
  remote: { site: string, plugins: string, desktop: string }
}

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

function cliArgs(): { skipSync: boolean, market: string | undefined, signKey: string, keyId: string, publisher?: string } {
  const skipSync = process.argv.includes('--skip-sync')
  const marketIndex = process.argv.indexOf('--market')
  const market = marketIndex >= 0 ? process.argv[marketIndex + 1] : undefined
  if (marketIndex >= 0 && (market === undefined || market === '')) {
    throw new Error('publish: --market requires a directory argument')
  }
  const signKeyIndex = process.argv.indexOf('--sign-key')
  const keyIdIndex = process.argv.indexOf('--key-id')
  const signKey = signKeyIndex >= 0 ? process.argv[signKeyIndex + 1] : undefined
  const keyId = keyIdIndex >= 0 ? process.argv[keyIdIndex + 1] : undefined
  if (signKey === undefined || signKey === '' || keyId === undefined || keyId === '') {
    throw new Error('publish: releases must be signed; pass --sign-key <private.pem> and --key-id <id>')
  }
  const publisherIndex = process.argv.indexOf('--publisher')
  const publisher = publisherIndex >= 0 ? process.argv[publisherIndex + 1] : undefined
  return { skipSync, market, signKey, keyId, ...(publisher === undefined ? {} : { publisher }) }
}

function run(command: string): void {
  console.log(`\n> ${command}`)
  execSync(command, { stdio: 'inherit', cwd: repoRoot })
}

function readDeployConfig(): DeployConfig {
  const path = join(repoRoot, 'deploy.config.json')
  if (!existsSync(path)) {
    throw new Error(`publish: 缺少 ${path} —— 复制 deploy.config.example.json 为 deploy.config.json 并按现场填写`)
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as DeployConfig
  if (typeof parsed.sshTarget !== 'string' || parsed.sshTarget === '') {
    throw new Error('publish: deploy.config.json 缺少 sshTarget')
  }
  if (typeof parsed.remote?.site !== 'string' || typeof parsed.remote?.plugins !== 'string' || typeof parsed.remote?.desktop !== 'string') {
    throw new Error('publish: deploy.config.json 缺少 remote.site / remote.plugins / remote.desktop')
  }
  return parsed
}

/** Load and sanity-check one recipe source directory. The plugins block must
 * already be the exact wire shape — publish is the first gate, the client
 * re-validates strictly on fetch. */
function loadRecipeSource(dir: string, id: string): RecipeSource {
  const docPath = join(dir, 'recipe.yml')
  if (!existsSync(docPath)) throw new Error(`publish: 组合 ${id} 缺少 recipe.yml`)
  const meta = load(readFileSync(docPath, 'utf8')) as RecipeSource['meta']
  if (typeof meta.version !== 'string' || meta.version === '') throw new Error(`publish: 组合 ${id} 缺少 version`)
  if (typeof meta.title !== 'string' || meta.title === '') throw new Error(`publish: 组合 ${id} 缺少 title`)
  if (meta.kind !== 'base' && meta.kind !== 'scenario') throw new Error(`publish: 组合 ${id} 的 kind 必须是 base 或 scenario`)
  if (!Array.isArray(meta.plugins) || meta.plugins.length === 0) throw new Error(`publish: 组合 ${id} 的 plugins 不能为空`)
  const namePattern = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/
  for (const row of meta.plugins) {
    const name = (row as { name?: unknown }).name
    if (typeof name !== 'string' || !namePattern.test(name)) {
      throw new Error(`publish: 组合 ${id} 含非法插件行 ${JSON.stringify(name)}`)
    }
  }
  const readmePath = join(dir, 'readme.md')
  return { id, meta, readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '', dir }
}

/** Assemble the feed's `recipes.json` and one strict-shaped document per
 * recipe (metadata stripped — the client validates the {plugins} shape).
 * The returned entries additionally carry the referenced package names for
 * the website's catalog. */
function assembleRecipes(): Array<RecipeCatalogEntry & { plugins: string[] }> {
  const recipesDir = join(repoRoot, 'recipes')
  const ids = existsSync(recipesDir) ? readdirSync(recipesDir) : []
  const entries: Array<RecipeCatalogEntry & { plugins: string[] }> = []
  for (const id of ids) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`publish: 组合目录名 ${id} 不是合法 id`)
    const source = loadRecipeSource(join(recipesDir, id), id)
    writeFileSync(
      join(stageDir, 'plugins', `${id}.yml`),
      dump({ plugins: source.meta.plugins }),
    )
    const entry: RecipeCatalogEntry & { plugins: string[] } = {
      id,
      version: source.meta.version as string,
      title: source.meta.title as string,
      kind: source.meta.kind as 'base' | 'scenario',
      file: `${id}.yml`,
      plugins: (source.meta.plugins as Array<{ name: string }>).map(row => row.name),
    }
    if (typeof source.meta.description === 'string' && source.meta.description !== '') {
      entry.description = source.meta.description
    }
    entries.push(entry)
    // Screenshots ride the feed under assets/recipes/<id>/ (catalog.json
    // references them by same-origin absolute path).
    const assets = join(source.dir, 'assets')
    if (existsSync(assets)) {
      cpSync(assets, join(stageDir, 'plugins', 'assets', 'recipes', id), { recursive: true })
    }
    console.log(`recipe ${id} (${entry.kind}, ${entry.plugins.length} rows)`)
  }
  writeFileSync(join(stageDir, 'plugins', 'recipes.json'), `${JSON.stringify({ recipes: entries.map(({ plugins, ...entry }) => entry) }, null, 2)}\n`)
  return entries
}

/** The rich catalog the website renders: the shipped index.json facts plus
 * the repo sources' author/repository/readme. The feed's index.json stays
 * the authority for everything zip-related — this only adds prose. */
function assembleCatalog(recipes: RecipeCatalogEntry[], marketDir: string | undefined): void {
  interface CatalogEntry {
    name: string
    version: string
    description?: string
    kind?: string
    title?: string
    category?: string
    requires?: string[]
    framework?: string
    file: string
    sha256?: string
    size?: number
    author?: string
    repository?: string
    license?: string
    readme?: string
    screenshots?: string[]
  }
  const plugins = JSON.parse(readFileSync(join(stageDir, 'plugins', 'index.json'), 'utf8')) as { plugins: CatalogEntry[] }
  const byName = new Map<string, CatalogEntry>(plugins.plugins.map(entry => [entry.name, entry]))
  for (const spec of PLUGIN_PACKAGES) {
    const entry = byName.get(spec.name)
    if (entry === undefined) continue
    const manifest = JSON.parse(readFileSync(join(spec.dir, 'package.json'), 'utf8')) as {
      author?: string | { name?: string }
      repository?: string | { url?: string }
      license?: string
    }
    if (typeof manifest.author === 'string') entry.author = manifest.author
    else if (typeof manifest.author?.name === 'string') entry.author = manifest.author.name
    if (typeof manifest.repository === 'string') entry.repository = manifest.repository
    else if (typeof manifest.repository?.url === 'string') entry.repository = manifest.repository.url
    if (typeof manifest.license === 'string') entry.license = manifest.license
    const readmePath = join(spec.dir, 'readme.md')
    if (existsSync(readmePath)) entry.readme = readFileSync(readmePath, 'utf8')
    const assets = join(spec.dir, 'assets')
    if (existsSync(assets)) {
      entry.screenshots = readdirSync(assets)
        .filter(file => /\.(png|jpg|jpeg|webp|svg)$/i.test(file))
        .map(file => `/snap-rail/plugins/assets/plugins/${entry.name.replaceAll('@', '').replaceAll('/', '-')}/${file}`)
      cpSync(assets, join(stageDir, 'plugins', 'assets', 'plugins', entry.name.replaceAll('@', '').replaceAll('/', '-')), { recursive: true })
    }
  }
  // Community packages ride the same feed: merge the market repo's pack
  // output (its index.json wins collisions; its own catalog prose, if any,
  // is already baked into its index entries).
  if (marketDir !== undefined) {
    const marketIndex = join(resolve(marketDir), 'index.json')
    if (!existsSync(marketIndex)) throw new Error(`publish: --market ${marketDir} 缺少 index.json`)
    const market = JSON.parse(readFileSync(marketIndex, 'utf8')) as { plugins: CatalogEntry[] }
    for (const entry of market.plugins) {
      byName.set(entry.name, entry)
      const zip = join(resolve(marketDir), entry.file)
      if (!existsSync(zip)) throw new Error(`publish: --market 缺少 ${entry.file}`)
      cpSync(zip, join(stageDir, 'plugins', entry.file))
    }
  }
  const catalog = {
    generatedAt: new Date().toISOString(),
    plugins: [...byName.values()],
    recipes: recipes.map(recipe => {
      const readmePath = join(repoRoot, 'recipes', recipe.id, 'readme.md')
      return {
        ...recipe,
        ...(existsSync(readmePath) ? { readme: readFileSync(readmePath, 'utf8') } : {}),
        screenshots: existsSync(join(stageDir, 'plugins', 'assets', 'recipes', recipe.id))
          ? readdirSync(join(stageDir, 'plugins', 'assets', 'recipes', recipe.id))
              .filter(file => /\.(png|jpg|jpeg|webp|svg)$/i.test(file))
              .map(file => `/snap-rail/plugins/assets/recipes/${recipe.id}/${file}`)
          : [],
      }
    }),
  }
  writeFileSync(join(stageDir, 'plugins', 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`catalog.json: ${catalog.plugins.length} plugins, ${catalog.recipes.length} recipes`)
}

/** rsync when the machine has it (keeps the feed clean with --delete);
 * otherwise a tar-over-ssh pipe — ssh exists wherever scp does, and this
 * avoids shell globbing entirely. */
function hasRsync(): boolean {
  try {
    execSync('rsync --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function syncDir(local: string, remote: string, config: DeployConfig, wipe: boolean): void {
  const target = `${config.sshTarget}:${remote}`
  if (wipe) execSync(`ssh ${config.sshTarget} "rm -rf ${remote} && mkdir -p ${remote}"`, { stdio: 'inherit' })
  else execSync(`ssh ${config.sshTarget} "mkdir -p ${remote}"`, { stdio: 'inherit' })
  if (hasRsync()) {
    execSync(`rsync -az ${local}/ ${target}/`, { stdio: 'inherit', cwd: repoRoot })
    return
  }
  execSync(`tar -czf - -C ${local} . | ssh ${config.sshTarget} "tar -xzf - -C ${remote}"`, { stdio: 'inherit', shell: 'bash' })
}

async function main(): Promise<void> {
  const { skipSync, market, signKey, keyId, publisher } = cliArgs()
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'plugins'), { recursive: true })

  run('pnpm run build')
  run(`pnpm run pack:plugins -- --out ${join(stageDir, 'plugins')} --sign-key ${signKey} --key-id ${keyId}${publisher === undefined ? '' : ` --publisher ${publisher}`}`)
  const recipes = assembleRecipes()
  assembleCatalog(recipes, market)

  // The website renders from the feed's catalog: regenerate its data module,
  // then build. dist-publish/site is what becomes the web root.
  run('pnpm exec tsx scripts/gen-website-catalog.ts')
  run('pnpm run website:build')
  cpSync(join(repoRoot, 'website', 'dist'), join(stageDir, 'site'), { recursive: true })

  // The desktop installer trio, when a packaged build exists.
  const releaseOut = join(repoRoot, 'apps/desktop/release-out')
  if (existsSync(join(releaseOut, 'latest.yml'))) {
    mkdirSync(join(stageDir, 'desktop'), { recursive: true })
    for (const file of readdirSync(releaseOut)) {
      if (file === 'latest.yml' || file.endsWith('.exe') || file.endsWith('.exe.blockmap')) {
        cpSync(join(releaseOut, file), join(stageDir, 'desktop', file))
      }
    }
    console.log('desktop artifacts staged from release-out')
  } else {
    console.log('no desktop artifacts (apps/desktop/release-out/latest.yml absent) — skipping desktop feed')
  }

  console.log(`\nstaged in ${stageDir}`)

  if (skipSync) {
    console.log('--skip-sync: nothing was uploaded')
    return
  }
  const config = readDeployConfig()
  // The site root is extracted over (stale hashed assets are harmless);
  // the feed and the desktop directory are wiped — they must be dedicated.
  syncDir(join(stageDir, 'site'), config.remote.site, config, false)
  syncDir(join(stageDir, 'plugins'), config.remote.plugins, config, true)
  if (existsSync(join(stageDir, 'desktop'))) {
    syncDir(join(stageDir, 'desktop'), config.remote.desktop, config, true)
  }
  console.log(`\npublished to ${config.sshTarget}`)
  console.log(`  site    → http://${config.sshTarget.split('@')[1] ?? config.sshTarget}/`)
  console.log(`  plugins → http://${config.sshTarget.split('@')[1] ?? config.sshTarget}/snap-rail/plugins/`)
  console.log(`  desktop → http://${config.sshTarget.split('@')[1] ?? config.sshTarget}/snap-rail/desktop/`)
}

// Run only when invoked directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(cause => {
    console.error(cause)
    process.exitCode = 1
  })
}
