/**
 * One-command release pipeline: build the repo, pack the plugin feed,
 * assemble the recipe catalog and the website catalog, and sync the artifacts
 * to the distribution target. Two targets are supported:
 *
 * 1. **Gitea** (intranet default) — the static feed (`plugins/` + `desktop/`)
 *    is committed to a dedicated feed branch of the client repo and served by
 *    Gitea raw; the installer trio additionally rides a Gitea Release for
 *    human download. The server stays logic-free — everything is plain files
 *    assembled here before one commit.
 * 2. **ssh/nginx** (legacy fallback) — rsync/tar-over-ssh into the web root,
 *    exactly the pre-Gitea deployment.
 *
 * Everything produces plain files under `dist-publish/` first, so a release
 * can be inspected before it syncs:
 *
 *   dist-publish/plugins/        ← index.json + recipes.json + catalog.json + zips + recipe docs (+ assets)
 *   dist-publish/site/           ← the built website (ssh target only)
 *   dist-publish/desktop/        ← latest.yml + setup exe + blockmap (when release-out has them)
 *
 * Usage: `pnpm run publish -- --sign-key <private.pem> --key-id <id> [--publisher <name>] [--skip-sync] [--market <dir>] [--release-tag <tag>]`
 *   --skip-sync        stage only; nothing leaves the machine.
 *   --market <dir>     merge a second feed's index.json/zips (a plugin repo's
 *     pack output) into the catalog.
 *   --release-tag <t>  Gitea Release tag override (default `v<desktop version>`).
 *
 * Configuration lives in `deploy.config.json` (gitignored;
 * `deploy.config.example.json` is the template). The `gitea` block wins when
 * present; otherwise the legacy `sshTarget` + `remote` block is used. The
 * API/push token comes from the `gitea.token` field or the `GITEA_TOKEN`
 * environment variable. The feed branch is wiped and rewritten on every
 * publish — it must be dedicated to snap-rail.
 *
 * @module snap-rail/scripts/publish
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
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

/** The Gitea distribution target: the static feed lives on a dedicated branch
 * of the client repo (Gitea raw serves plain files), and the installer trio
 * rides a Gitea Release for human download. */
interface GiteaConfig {
  url: string
  owner: string
  repo: string
  /** Branch carrying the feed tree; seeded as an orphan branch on first publish. */
  feedBranch?: string
  /** Attach the installer trio to a Gitea Release (default on when desktop artifacts exist). */
  release?: boolean
  /** API/push token; falls back to the `GITEA_TOKEN` environment variable. */
  token?: string
}

interface DeployConfig {
  /** Gitea target — the intranet distribution path; wins over ssh when present. */
  gitea?: GiteaConfig
  /** Legacy nginx target (ssh + rsync/tar) — the fallback deployment. */
  sshTarget?: string
  remote?: { site: string, plugins: string, desktop: string }
}

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

function cliArgs(): { skipSync: boolean, market: string | undefined, signKey: string, keyId: string, publisher?: string, releaseTag: string | undefined } {
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
  const releaseTagIndex = process.argv.indexOf('--release-tag')
  const releaseTag = releaseTagIndex >= 0 ? process.argv[releaseTagIndex + 1] : undefined
  return { skipSync, market, signKey, keyId, ...(publisher === undefined ? {} : { publisher }), releaseTag }
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
  if (parsed.gitea !== undefined) {
    const { url, owner, repo } = parsed.gitea
    if (typeof url !== 'string' || url === '' || typeof owner !== 'string' || owner === '' || typeof repo !== 'string' || repo === '') {
      throw new Error('publish: deploy.config.json 的 gitea 块缺少 url / owner / repo')
    }
    return parsed
  }
  if (typeof parsed.sshTarget !== 'string' || parsed.sshTarget === '') {
    throw new Error('publish: deploy.config.json 需要 gitea 块（推荐）或 sshTarget + remote（nginx 兼容路径）')
  }
  if (typeof parsed.remote?.site !== 'string' || typeof parsed.remote?.plugins !== 'string' || typeof parsed.remote?.desktop !== 'string') {
    throw new Error('publish: deploy.config.json 缺少 remote.site / remote.plugins / remote.desktop')
  }
  return parsed
}

/** The version the desktop installer was built with (electron-builder reads
 * the same manifest), used for the default Release tag and commit messages. */
function desktopVersion(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8')) as { version?: string }
  return manifest.version ?? '0.0.0'
}

// ---------------------------------------------------------------------------
// Gitea target
// ---------------------------------------------------------------------------

const FEED_BRANCH_DEFAULT = 'feed'

function giteaToken(gitea: GiteaConfig): string {
  const token = gitea.token ?? process.env.GITEA_TOKEN ?? ''
  return token.trim()
}

function giteaBase(gitea: GiteaConfig): string {
  return gitea.url.replace(/\/+$/, '')
}

function repoPushUrl(gitea: GiteaConfig): string {
  const origin = `${giteaBase(gitea)}/${gitea.owner}/${gitea.repo}.git`
  const token = giteaToken(gitea)
  return token === '' ? origin : origin.replace('://', `://oauth2:${token}@`)
}

async function giteaRequest<T>(gitea: GiteaConfig, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${giteaBase(gitea)}/api/v1${path}`, {
    ...init,
    headers: {
      ...(token === '' ? {} : { Authorization: `token ${token}` }),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`gitea: ${response.status} ${response.statusText} — ${path}${detail === '' ? '' : `：${detail}`}`)
  }
  const text = await response.text()
  return (text === '' ? undefined : JSON.parse(text)) as T
}

/** Git with the token carried in an extra HTTP header (never in the URL or
 * remote config, so credentials never leak into logs or the worktree). */
function gitAuthArgs(gitea: GiteaConfig): string[] {
  const token = giteaToken(gitea)
  return token === '' ? [] : ['-c', `http.extraHeader=Authorization: token ${token}`]
}

function git(dir: string, gitea: GiteaConfig, ...args: string[]): string {
  return execFileSync('git', [...gitAuthArgs(gitea), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function hasHead(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Push the staged feed tree to the dedicated feed branch. The branch is an
 * orphan seeded from an empty tree on first publish, and its whole tree is
 * replaced on every publish — it must be dedicated to snap-rail. */
export async function syncGiteaFeed(gitea: GiteaConfig, stageDir: string, version: string): Promise<void> {
  const branch = gitea.feedBranch ?? FEED_BRANCH_DEFAULT
  const worktree = join(stageDir, 'feed-worktree')
  rmSync(worktree, { recursive: true, force: true })
  const remote = repoPushUrl(gitea)
  try {
    execFileSync('git', [...gitAuthArgs(gitea), 'clone', '--depth', '1', '--branch', branch, remote, worktree], { stdio: 'ignore' })
  } catch {
    // The branch does not exist yet (or the repo is empty): clone the default
    // state and seed the feed branch from an empty tree.
    rmSync(worktree, { recursive: true, force: true })
    execFileSync('git', [...gitAuthArgs(gitea), 'clone', '--depth', '1', remote, worktree], { stdio: 'inherit' })
    git(worktree, gitea, 'switch', ...(hasHead(worktree) ? ['--orphan'] : ['-c']), branch)
  }
  // The desktop trio outlives plugin-only publishes: a CI publish (which
  // builds no installer) must not wipe the feed's installer files. Stash the
  // branch's existing desktop/ before the whole-tree replace, restore it when
  // nothing new was staged.
  const preservedDesktop = join(stageDir, 'desktop-preserved')
  const existingDesktop = join(worktree, 'desktop')
  const hadDesktop = existsSync(existingDesktop)
  if (hadDesktop) cpSync(existingDesktop, preservedDesktop, { recursive: true })
  for (const entry of readdirSync(worktree)) {
    if (entry === '.git') continue
    rmSync(join(worktree, entry), { recursive: true, force: true })
  }
  cpSync(join(stageDir, 'plugins'), join(worktree, 'plugins'), { recursive: true })
  const desktopStaged = join(stageDir, 'desktop')
  if (existsSync(desktopStaged)) {
    cpSync(desktopStaged, join(worktree, 'desktop'), { recursive: true })
  } else if (hadDesktop) {
    cpSync(preservedDesktop, join(worktree, 'desktop'), { recursive: true })
    console.log('gitea: 本地无 desktop 产物，保留 feed 分支上现有 desktop/')
  }
  rmSync(preservedDesktop, { recursive: true, force: true })
  // The feed is served byte-exact: forbid every EOL/normalization conversion
  // regardless of the publisher's core.autocrlf.
  writeFileSync(join(worktree, '.gitattributes'), '* -text\n')
  git(worktree, gitea, 'add', '-A')
  const identityArgs = (() => {
    try {
      return git(worktree, gitea, 'config', 'user.email') === ''
        ? ['-c', 'user.name=snap-rail publisher', '-c', 'user.email=publisher@snap-rail.invalid']
        : []
    } catch {
      return ['-c', 'user.name=snap-rail publisher', '-c', 'user.email=publisher@snap-rail.invalid']
    }
  })()
  execFileSync(
    'git',
    [...identityArgs, 'commit', '-m', `chore(feed): publish for v${version} (${new Date().toISOString()})`],
    { cwd: worktree, stdio: 'inherit' },
  )
  execFileSync('git', [...gitAuthArgs(gitea), 'push', '-u', 'origin', branch], { cwd: worktree, stdio: 'inherit' })
  rmSync(worktree, { recursive: true, force: true })
  console.log(`feed branch pushed: ${giteaBase(gitea)}/${gitea.owner}/${gitea.repo}/raw/branch/${branch}/plugins/`)
}

interface GiteaRelease {
  id: number
  assets?: Array<{ id: number, name: string }>
}

/** Create (or reuse) the tag Release and upload the installer trio for human
 * download. Same-name assets are replaced, so republishing a tag is safe. */
export async function publishGiteaRelease(gitea: GiteaConfig, stageDir: string, tag: string): Promise<void> {
  const token = giteaToken(gitea)
  if (token === '') {
    console.log('gitea: 未配置 token（gitea.token 或 GITEA_TOKEN），跳过 Release 发布（feed 分支已推送）')
    return
  }
  const assetDir = join(stageDir, 'desktop')
  if (!existsSync(join(assetDir, 'latest.yml'))) {
    console.log('gitea: 无 desktop 产物（release-out/latest.yml 缺失），跳过 Release 发布')
    return
  }
  const assetNames = readdirSync(assetDir).filter(file => file === 'latest.yml' || file.endsWith('.exe') || file.endsWith('.exe.blockmap'))
  let release = await giteaRequest<GiteaRelease | undefined>(gitea, token, `/repos/${gitea.owner}/${gitea.repo}/releases/tags/${encodeURIComponent(tag)}`)
    .catch(() => undefined)
  if (release === undefined || release === null || typeof release.id !== 'number') {
    release = await giteaRequest<GiteaRelease>(gitea, token, `/repos/${gitea.owner}/${gitea.repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: `snap-rail 客户端 ${tag}\n\n- 人工下载：本页附件（snap-rail-*-setup.exe）\n- 自动更新与插件市场：feed 分支静态目录（见 docs/deploy.md 的 Gitea 部署节）`,
        draft: false,
        prerelease: false,
      }),
    })
  }
  for (const name of assetNames) {
    for (const existing of release.assets ?? []) {
      if (existing.name === name) {
        await giteaRequest(gitea, token, `/repos/${gitea.owner}/${gitea.repo}/releases/${release.id}/assets/${existing.id}`, { method: 'DELETE' })
      }
    }
    const bytes = readFileSync(join(assetDir, name))
    await giteaRequest(gitea, token, `/repos/${gitea.owner}/${gitea.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    console.log(`release asset uploaded: ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`)
  }
  console.log(`release: ${giteaBase(gitea)}/${gitea.owner}/${gitea.repo}/releases/tag/${encodeURIComponent(tag)}`)
}

async function syncGitea(gitea: GiteaConfig, stageDir: string, releaseTag: string | undefined): Promise<void> {
  const version = desktopVersion()
  await syncGiteaFeed(gitea, stageDir, version)
  if (gitea.release !== false) {
    await publishGiteaRelease(gitea, stageDir, releaseTag ?? `v${version}`)
  }
  const branch = gitea.feedBranch ?? FEED_BRANCH_DEFAULT
  const base = `${giteaBase(gitea)}/${gitea.owner}/${gitea.repo}/raw/branch/${branch}`
  console.log(`\npublished to ${giteaBase(gitea)} (${gitea.owner}/${gitea.repo})`)
  console.log(`  update.feedUrl → ${base}/desktop/`)
  console.log(`  plugins.feedUrl → ${base}/plugins/`)
}

// ---------------------------------------------------------------------------
// Recipes / catalog assembly
// ---------------------------------------------------------------------------

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
  // Contributor packages ride the same feed: merge the contributor repo's
  // pack output (its index.json wins collisions).
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
    // The terminal's market layer fetches `index.json` (catalog.json is the
    // website's rich render) — the merged plugin set is the feed's actual
    // catalog, so the merge rewrites it, not just the rich copy.
    writeFileSync(join(stageDir, 'plugins', 'index.json'), `${JSON.stringify({ plugins: [...byName.values()] }, null, 2)}\n`)
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

// ---------------------------------------------------------------------------
// Legacy ssh/nginx target
// ---------------------------------------------------------------------------

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

interface LegacyConfig { sshTarget: string, remote: { site: string, plugins: string, desktop: string } }

function syncDir(local: string, remote: string, config: LegacyConfig, wipe: boolean): void {
  const target = `${config.sshTarget}:${remote}`
  if (wipe) execSync(`ssh ${config.sshTarget} "rm -rf ${remote} && mkdir -p ${remote}"`, { stdio: 'inherit' })
  else execSync(`ssh ${config.sshTarget} "mkdir -p ${remote}"`, { stdio: 'inherit' })
  if (hasRsync()) {
    execSync(`rsync -az ${local}/ ${target}/`, { stdio: 'inherit', cwd: repoRoot })
    return
  }
  execSync(`tar -czf - -C ${local} . | ssh ${config.sshTarget} "tar -xzf - -C ${remote}"`, { stdio: 'inherit', shell: 'bash' })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { skipSync, market, signKey, keyId, publisher, releaseTag } = cliArgs()
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'plugins'), { recursive: true })

  run('pnpm run build')
  run(`pnpm run pack:plugins -- --out ${join(stageDir, 'plugins')} --sign-key ${signKey} --key-id ${keyId}${publisher === undefined ? '' : ` --publisher ${publisher}`}`)
  const recipes = assembleRecipes()
  assembleCatalog(recipes, market)

  // The distribution target decides whether the website ships at all: the
  // Gitea feed carries no site (the website stays on nginx per docs/deploy.md).
  let gitea: GiteaConfig | undefined
  let legacy: LegacyConfig | undefined
  if (!skipSync) {
    const config = readDeployConfig()
    gitea = config.gitea
    legacy = gitea === undefined ? { sshTarget: config.sshTarget!, remote: config.remote! } : undefined
  }
  if (gitea === undefined) {
    // The website renders from the feed's catalog: regenerate its data module,
    // then build. dist-publish/site is what becomes the web root.
    run('pnpm exec tsx scripts/gen-website-catalog.ts')
    run('pnpm run website:build')
    cpSync(join(repoRoot, 'website', 'dist'), join(stageDir, 'site'), { recursive: true })
  }

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
  if (gitea !== undefined) {
    await syncGitea(gitea, stageDir, releaseTag)
    return
  }
  if (legacy === undefined) throw new Error('publish: 未配置分发目标')
  // The site root is extracted over (stale hashed assets are harmless);
  // the feed and the desktop directory are wiped — they must be dedicated.
  syncDir(join(stageDir, 'site'), legacy.remote.site, legacy, false)
  syncDir(join(stageDir, 'plugins'), legacy.remote.plugins, legacy, true)
  if (existsSync(join(stageDir, 'desktop'))) {
    syncDir(join(stageDir, 'desktop'), legacy.remote.desktop, legacy, true)
  }
  console.log(`\npublished to ${legacy.sshTarget}`)
  console.log(`  site    → http://${legacy.sshTarget.split('@')[1] ?? legacy.sshTarget}/`)
  console.log(`  plugins → http://${legacy.sshTarget.split('@')[1] ?? legacy.sshTarget}/snap-rail/plugins/`)
  console.log(`  desktop → http://${legacy.sshTarget.split('@')[1] ?? legacy.sshTarget}/snap-rail/desktop/`)
}

// Run only when invoked directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(cause => {
    console.error(cause)
    process.exitCode = 1
  })
}
