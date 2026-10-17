/**
 * One-command release pipeline: build the repo, pack the first-party plugin
 * zips, merge collected first-party repo zips (`--collect`), assemble the
 * offline combo packages, and sync the artifacts to the distribution
 * targets as one **rolling release** — a fixed tag (default `feed`) whose
 * assets are deleted and recreated on every publish. The server stays
 * logic-free: everything is plain files assembled here before the upload.
 *
 * Two target kinds share the same rolling-release mechanics (their download
 * URL shapes are identical, so terminals switch by pointing the feed URL):
 *
 * 1. **gitea** (intranet default) — `…/releases/download/feed/<file>`.
 * 2. **github** — `https://github.com/<owner>/<repo>/releases/download/feed/<file>`
 *    (the public rollout path; the token rides a CI secret).
 *
 * Everything produces plain files under `dist-publish/` first, so a release
 * can be inspected before it syncs:
 *
 *   dist-publish/plugins/        ← index.json + catalog.json + plugin zips + combo zips
 *   dist-publish/desktop/        ← latest.yml + setup exe + blockmap (when release-out has them)
 *
 * Release assets are flat: the plugins and desktop trios ride the same
 * release as flat siblings (`index.json`, `latest.yml`, `*.zip`, …), so one
 * base URL serves both `plugins.feedUrl` and `update.feedUrl`. Combo image
 * assets (`plugins/assets/`) stay staged for the website build only — they
 * do not upload.
 *
 * A combo zip is the offline install unit: the root carries `recipe.yml`
 * (the strict combo document, same shape as `plugins.yml` plus identity) and
 * `plugins/<file>.zip` — the exact signed member zips the feed serves — plus
 * an optional `readme.md`. The terminal inspects by content, installs every
 * missing/outdated member, then writes the preset.
 *
 * Usage: `pnpm run publish -- --sign-key <private.pem> --key-id <id> [--publisher <name>] [--skip-sync] [--collect <dir>]... [--feed-tag <tag>]`
 *   --skip-sync        stage only; nothing leaves the machine.
 *   --collect <dir>    merge a first-party plugin repo's pack output
 *     (`index.json` + zips) into the feed; repeatable. Community plugins do
 *     not come through here — they live in their authors' own feeds.
 *   --feed-tag <t>     rolling release tag override (default `feed`).
 *
 * Configuration lives in `deploy.config.json` (gitignored;
 * `deploy.config.example.json` is the template): `{ "targets": [ { "kind":
 * "gitea" | "github", … } ] }`. Tokens come from each target's `token` field
 * or the `GITEA_TOKEN` / `GITHUB_TOKEN` environment variables.
 *
 * @module snap-rail/scripts/publish
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { dump, load } from 'js-yaml'
import { recipeDocumentSchema, recipePackageNames, type RecipeDocument } from '@snap-rail/plugin-kit/recipe'
import { PLUGIN_PACKAGES } from './pack-plugins.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stageDir = join(repoRoot, 'dist-publish')

/** One combo catalog card (the website's rich render; the zip itself is the
 * install unit). */
interface ComboCatalogEntry {
  id: string
  version: string
  title: string
  description?: string
  kind: 'base' | 'scenario'
  file: string
  plugins: string[]
  readme?: string
  screenshots?: string[]
}

/** One source combo directory: `recipes/<id>/recipe.yml` + `readme.md` (+ `assets/`). */
interface ComboSource {
  id: string
  document: RecipeDocument
  readme: string
  dir: string
}

/** A rolling-release distribution target. Both kinds delete-and-recreate the
 * fixed-tag release on every publish; only the API dialects differ. */
export type ReleaseTarget =
  | { kind: 'gitea', url: string, owner: string, repo: string, token?: string }
  | { kind: 'github', url?: string, owner: string, repo: string, token?: string }

interface DeployConfig {
  /** The rolling-release targets; every entry receives the same assets. */
  targets?: readonly ReleaseTarget[]
  /** The rolling release tag (default `feed`). */
  feedTag?: string
}

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

function cliArgs(): { skipSync: boolean, collect: string[], signKey: string, keyId: string, publisher?: string, feedTag: string | undefined } {
  const skipSync = process.argv.includes('--skip-sync')
  const collect: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== '--collect') continue
    const value = process.argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error('publish: --collect requires a directory argument')
    }
    collect.push(value)
    index += 1
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
  const feedTagIndex = process.argv.indexOf('--feed-tag')
  const feedTag = feedTagIndex >= 0 ? process.argv[feedTagIndex + 1] : undefined
  return { skipSync, collect, signKey, keyId, ...(publisher === undefined ? {} : { publisher }), feedTag }
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
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error('publish: deploy.config.json 需要 targets 数组（kind: gitea 或 github）')
  }
  for (const target of parsed.targets) {
    if (target.kind !== 'gitea' && target.kind !== 'github') {
      throw new Error(`publish: 未知 target kind ${String((target as { kind?: unknown }).kind)}`)
    }
    if (typeof target.owner !== 'string' || target.owner === '' || typeof target.repo !== 'string' || target.repo === '') {
      throw new Error('publish: 每个 target 需要 owner 与 repo')
    }
    if (target.kind === 'gitea' && (typeof target.url !== 'string' || target.url === '')) {
      throw new Error('publish: gitea target 需要 url')
    }
  }
  return parsed
}

/** The version the desktop installer was built with (electron-builder reads
 * the same manifest), used for release notes. */
function desktopVersion(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8')) as { version?: string }
  return manifest.version ?? '0.0.0'
}

// ---------------------------------------------------------------------------
// Rolling-release targets
// ---------------------------------------------------------------------------

const FEED_TAG_DEFAULT = 'feed'

/** One API dialect over the same delete-and-recreate rolling release. */
interface ReleaseHost {
  kind: 'gitea' | 'github'
  /** The human-facing download base printed after the sync. */
  downloadBase: string
  /** API origin (GitHub uploads switch hosts for assets). */
  apiBase: string
  uploadBase: string
  owner: string
  repo: string
  token: string
  headers(init?: RequestInit): Record<string, string>
  releaseByTagPath(tag: string): string
  releasePath(id: number): string
  deleteTagPath(tag: string): string
  createReleasePath(): string
  uploadAssetPath(id: number, name: string): string
}

function tokenOf(target: ReleaseTarget): string {
  const fromEnv = target.kind === 'github' ? process.env.GITHUB_TOKEN : process.env.GITEA_TOKEN
  return (target.token ?? fromEnv ?? '').trim()
}

function hostOf(target: ReleaseTarget): ReleaseHost {
  const token = tokenOf(target)
  if (target.kind === 'gitea') {
    const base = target.url.replace(/\/+$/, '')
    return {
      kind: 'gitea',
      downloadBase: `${base}/${target.owner}/${target.repo}/releases/download`,
      apiBase: `${base}/api/v1`,
      uploadBase: `${base}/api/v1`,
      owner: target.owner,
      repo: target.repo,
      token,
      headers: init => ({
        ...(token === '' ? {} : { Authorization: `token ${token}` }),
        ...(init?.headers ?? {}),
      }),
      releaseByTagPath: tag => `/repos/${target.owner}/${target.repo}/releases/tags/${encodeURIComponent(tag)}`,
      releasePath: id => `/repos/${target.owner}/${target.repo}/releases/${id}`,
      deleteTagPath: tag => `/repos/${target.owner}/${target.repo}/tags/${encodeURIComponent(tag)}`,
      createReleasePath: () => `/repos/${target.owner}/${target.repo}/releases`,
      uploadAssetPath: (id, name) => `/repos/${target.owner}/${target.repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    }
  }
  const base = (target.url ?? 'https://api.github.com').replace(/\/+$/, '')
  const uploadHost = base.replace('//api.', '//uploads.')
  return {
    kind: 'github',
    downloadBase: `https://github.com/${target.owner}/${target.repo}/releases/download`,
    apiBase: base,
    uploadBase: uploadHost,
    owner: target.owner,
    repo: target.repo,
    token,
    headers: init => ({
      Accept: 'application/vnd.github+json',
      ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
      ...(init?.headers ?? {}),
    }),
    releaseByTagPath: tag => `/repos/${target.owner}/${target.repo}/releases/tags/${encodeURIComponent(tag)}`,
    releasePath: id => `/repos/${target.owner}/${target.repo}/releases/${id}`,
    deleteTagPath: tag => `/repos/${target.owner}/${target.repo}/git/refs/tags/${encodeURIComponent(tag)}`,
    createReleasePath: () => `/repos/${target.owner}/${target.repo}/releases`,
    uploadAssetPath: (id, name) => `/repos/${target.owner}/${target.repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
  }
}

async function apiRequest<T>(host: ReleaseHost, path: string, init?: RequestInit, base = host.apiBase): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: host.headers(init) })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`${host.kind}: ${response.status} ${response.statusText} — ${path}${detail === '' ? '' : `：${detail}`}`)
  }
  const text = await response.text()
  return (text === '' ? undefined : JSON.parse(text)) as T
}

interface ReleaseDto {
  id: number
  assets?: Array<{ id: number, name: string }>
}

/** The flat files one rolling release carries: everything staged for the
 * plugin feed plus the desktop updater trio, as name→path pairs. Combo
 * image assets (`plugins/assets/`) stay out — they serve the website build,
 * and release assets are flat. */
function collectFlatAssets(stage: string): Array<{ name: string, path: string }> {
  const assets: Array<{ name: string, path: string }> = []
  const seen = new Set<string>()
  const addDir = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (!statSync(path).isFile()) continue
      if (seen.has(entry)) throw new Error(`publish: 资产名冲突（${entry} 同时出现于多个目录）`)
      seen.add(entry)
      assets.push({ name: entry, path })
    }
  }
  addDir(join(stage, 'plugins'))
  if (existsSync(join(stage, 'desktop'))) addDir(join(stage, 'desktop'))
  return assets
}

/** Sync the staged tree to one target's rolling release: delete the fixed
 * tag's release (and the tag), recreate both, upload every flat asset. The
 * whole replace is one pipeline — a failed publish leaves the previous
 * release gone but reproducible by rerunning. */
export async function syncRollingRelease(target: ReleaseTarget, stage: string, tag: string): Promise<void> {
  const host = hostOf(target)
  if (host.token === '') {
    throw new Error(`publish: ${host.kind} target 缺少 token（配置 token 字段或 ${host.kind === 'github' ? 'GITHUB_TOKEN' : 'GITEA_TOKEN'}）`)
  }
  const assets = collectFlatAssets(stage)
  if (assets.length === 0) throw new Error('publish: 没有可上传的资产（dist-publish 为空）')
  // Retire the previous rolling release; a missing one is the first publish.
  const existing = await apiRequest<ReleaseDto | undefined>(host, host.releaseByTagPath(tag)).catch(() => undefined)
  if (existing !== undefined && existing !== null && typeof existing.id === 'number') {
    await apiRequest(host, host.releasePath(existing.id), { method: 'DELETE' })
  }
  await apiRequest(host, host.deleteTagPath(tag), { method: 'DELETE' }).catch(() => undefined)
  const release = await apiRequest<ReleaseDto>(host, host.createReleasePath(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: `snap-rail 插件源与更新源（滚动发布，v${desktopVersion()}，${new Date().toISOString()}）\n\n- 插件源地址（plugins.feedUrl）：${host.downloadBase}/${tag}/\n- 应用更新源（update.feedUrl）：同上一地址（latest.yml 平铺）`,
      draft: false,
      prerelease: false,
    }),
  })
  for (const asset of assets) {
    const bytes = readFileSync(asset.path)
    await apiRequest(host, host.uploadAssetPath(release.id, asset.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }, host.uploadBase)
    console.log(`${host.kind}: asset uploaded: ${asset.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`)
  }
  console.log(`${host.kind}: rolling release ${tag} → ${host.downloadBase}/${tag}/`)
}

// ---------------------------------------------------------------------------
// Collected first-party feeds / combo assembly / website catalog
// ---------------------------------------------------------------------------

/** One plugin entry the feed's `index.json` carries (feed facts only). */
interface CatalogPluginEntry {
  name: string
  version: string
  description?: string
  kind?: string
  title?: string
  category?: string
  requires?: string[]
  permissions?: string[]
  file: string
  sha256?: string
  size?: number
  signature?: { algorithm: 'Ed25519', keyId: string }
  engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
  author?: string
  repository?: string
  license?: string
  readme?: string
  screenshots?: string[]
}

/**
 * Merge the first-party plugin repos' pack outputs (each `--collect <dir>`)
 * into the staged feed: their zips join flat under `plugins/`, entries
 * replace same-named rows (the collected repo's freshly signed zip wins),
 * and `index.json` is rewritten. This is the org collecting its own split
 * repos — community plugins never come through here; they live in their
 * authors' own feeds and users add those by URL.
 *
 * @param dirs - pack-output directories, each holding `index.json` + zips.
 */
function mergeCollected(dirs: readonly string[]): void {
  if (dirs.length === 0) return
  const indexPath = join(stageDir, 'plugins', 'index.json')
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { plugins: CatalogPluginEntry[] }
  const byName = new Map(index.plugins.map(entry => [entry.name, entry]))
  for (const dir of dirs) {
    const sourceDir = resolve(dir)
    const sourceIndex = join(sourceDir, 'index.json')
    if (!existsSync(sourceIndex)) throw new Error(`publish: --collect ${dir} 缺少 index.json`)
    const collected = JSON.parse(readFileSync(sourceIndex, 'utf8')) as { plugins: CatalogPluginEntry[] }
    if (!Array.isArray(collected.plugins)) throw new Error(`publish: --collect ${dir} 的 index.json.plugins 不是数组`)
    for (const entry of collected.plugins) {
      if (typeof entry.name !== 'string' || typeof entry.file !== 'string') {
        throw new Error(`publish: --collect ${dir} 的条目缺少 name/file`)
      }
      const sourceZip = join(sourceDir, entry.file)
      if (!existsSync(sourceZip)) throw new Error(`publish: --collect ${dir} 缺少 ${entry.file}`)
      cpSync(sourceZip, join(stageDir, 'plugins', entry.file))
      byName.set(entry.name, entry)
      console.log(`collected ${entry.name}@${entry.version ?? '?'}`)
    }
  }
  writeFileSync(indexPath, `${JSON.stringify({ plugins: [...byName.values()] }, null, 2)}\n`)
}

/** Load and strictly validate one combo source directory. `recipe.yml` is
 * the single manifest (identity + rows); publish is the first gate, the
 * terminal re-validates the same schema on inspect. */
function loadComboSource(dir: string, id: string): ComboSource {
  const docPath = join(dir, 'recipe.yml')
  if (!existsSync(docPath)) throw new Error(`publish: 组合 ${id} 缺少 recipe.yml`)
  let parsed: unknown
  try {
    parsed = load(readFileSync(docPath, 'utf8'))
  } catch (cause) {
    throw new Error(`publish: 组合 ${id} 的 recipe.yml 不是合法 YAML`, { cause })
  }
  const document = recipeDocumentSchema.safeParse(parsed)
  if (!document.success) {
    const issue = document.error.issues[0]
    throw new Error(`publish: 组合 ${id} 的 recipe.yml 不合法（${issue?.path.join('.') ?? 'recipe'}: ${issue?.message ?? 'unknown'}）`)
  }
  if (document.data.id !== id) {
    throw new Error(`publish: 组合目录 ${id} 与 recipe.yml 的 id ${document.data.id} 不一致`)
  }
  const readmePath = join(dir, 'readme.md')
  return { id, document: document.data, readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '', dir }
}

/**
 * Assemble one offline combo zip per recipe source: `recipe.yml` at the
 * root, the exact signed member zips under `plugins/`, an optional
 * `readme.md`. Member bytes are copied from the staged feed, so a combo can
 * never carry a zip the feed does not also serve (the combo has no signature
 * of its own — each member keeps its release signature).
 *
 * @returns the website's combo cards (readme + screenshots included).
 */
function assembleCombos(): ComboCatalogEntry[] {
  const index = JSON.parse(readFileSync(join(stageDir, 'plugins', 'index.json'), 'utf8')) as { plugins: CatalogPluginEntry[] }
  const byName = new Map(index.plugins.map(entry => [entry.name, entry]))
  const recipesDir = join(repoRoot, 'recipes')
  const ids = existsSync(recipesDir) ? readdirSync(recipesDir).sort() : []
  const combos: ComboCatalogEntry[] = []
  for (const id of ids) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`publish: 组合目录名 ${id} 不是合法 id`)
    const source = loadComboSource(join(recipesDir, id), id)
    const files: Record<string, Uint8Array> = {
      'recipe.yml': new TextEncoder().encode(dump(source.document)),
      ...(source.readme === '' ? {} : { 'readme.md': new TextEncoder().encode(source.readme) }),
    }
    const members = recipePackageNames(source.document)
    for (const packageName of members) {
      const entry = byName.get(packageName)
      if (entry === undefined) {
        throw new Error(`publish: 组合 ${id} 引用的 ${packageName} 不在 feed 目录中（先 pack:plugins / --collect 该仓）`)
      }
      files[`plugins/${entry.file}`] = new Uint8Array(readFileSync(join(stageDir, 'plugins', entry.file)))
    }
    const zipped = zipSync(files, { level: 9 })
    writeFileSync(join(stageDir, 'plugins', `${id}.zip`), zipped)
    // Combo screenshots ride the feed under assets/recipes/<id>/ for the
    // website build only; the zip stays prose + members.
    const assets = join(source.dir, 'assets')
    const screenshots = existsSync(assets)
      ? readdirSync(assets)
          .filter(file => /\.(png|jpg|jpeg|webp|svg)$/i.test(file))
          .map(file => `./site-assets/recipes/${id}/${file}`)
      : []
    if (existsSync(assets)) {
      cpSync(assets, join(stageDir, 'plugins', 'assets', 'recipes', id), { recursive: true })
    }
    combos.push({
      id,
      version: source.document.version,
      title: source.document.title,
      ...(source.document.description !== undefined ? { description: source.document.description } : {}),
      kind: source.document.kind,
      file: `${id}.zip`,
      plugins: members,
      ...(source.readme !== '' ? { readme: source.readme } : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
    })
    console.log(`combo ${id} (${source.document.kind}, ${members.length} members, ${(zipped.length / 1024).toFixed(0)} KiB)`)
  }
  return combos
}

/**
 * The rich catalog the website renders: the shipped index.json facts plus
 * the repo sources' author/repository/readme and the combos. The feed's
 * `index.json` stays the authority for everything zip-related — this only
 * adds prose. Image paths are website-relative (`./site-assets/...`) so the
 * same build works under GitHub Pages' project path and an intranet root.
 *
 * @param combos - the combo cards assembled from the recipe sources.
 */
function assembleCatalog(combos: readonly ComboCatalogEntry[]): void {
  const index = JSON.parse(readFileSync(join(stageDir, 'plugins', 'index.json'), 'utf8')) as { plugins: CatalogPluginEntry[] }
  const byName = new Map(index.plugins.map(entry => [entry.name, entry]))
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
      const slug = entry.name.replaceAll('@', '').replaceAll('/', '-')
      entry.screenshots = readdirSync(assets)
        .filter(file => /\.(png|jpg|jpeg|webp|svg)$/i.test(file))
        .map(file => `./site-assets/plugins/${slug}/${file}`)
      cpSync(assets, join(stageDir, 'plugins', 'assets', 'plugins', slug), { recursive: true })
    }
  }
  const catalog = {
    generatedAt: new Date().toISOString(),
    plugins: [...byName.values()],
    combos,
  }
  writeFileSync(join(stageDir, 'plugins', 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`catalog.json: ${catalog.plugins.length} plugins, ${catalog.combos.length} combos`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { skipSync, collect, signKey, keyId, publisher, feedTag } = cliArgs()
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, 'plugins'), { recursive: true })

  run('pnpm run build')
  run(`pnpm run pack:plugins -- --out ${join(stageDir, 'plugins')} --sign-key ${signKey} --key-id ${keyId}${publisher === undefined ? '' : ` --publisher ${publisher}`}`)
  mergeCollected(collect)
  const combos = assembleCombos()
  assembleCatalog(combos)

  // The desktop updater trio, when a packaged build exists — it rides the
  // same rolling release as flat siblings of the plugin feed. Stage exactly
  // the trio latest.yml points at: a reused release-out may still hold an
  // older installer, and uploading it next to the current one would make the
  // release lie about which build is current.
  const releaseOut = join(repoRoot, 'apps/desktop/release-out')
  const latestYml = join(releaseOut, 'latest.yml')
  if (existsSync(latestYml)) {
    const latest = load(readFileSync(latestYml, 'utf8')) as { path?: unknown }
    if (typeof latest.path !== 'string' || latest.path === '') {
      throw new Error('publish: apps/desktop/release-out/latest.yml 缺少 path')
    }
    mkdirSync(join(stageDir, 'desktop'), { recursive: true })
    for (const file of [latest.path, `${latest.path}.blockmap`, 'latest.yml']) {
      const source = join(releaseOut, file)
      if (!existsSync(source)) throw new Error(`publish: 缺少桌面产物 ${source}`)
      // cpSync import kept minimal: a plain read/write pair avoids the copy
      // touching file times the API upload does not care about anyway.
      writeFileSync(join(stageDir, 'desktop', file), readFileSync(source))
    }
    console.log(`desktop artifacts staged from release-out (${latest.path})`)
  } else {
    console.log('no desktop artifacts (apps/desktop/release-out/latest.yml absent) — skipping desktop feed')
  }

  console.log(`\nstaged in ${stageDir}`)

  if (skipSync) {
    console.log('--skip-sync: nothing was uploaded')
    return
  }
  const config = readDeployConfig()
  const tag = feedTag ?? config.feedTag ?? FEED_TAG_DEFAULT
  for (const target of config.targets!) {
    await syncRollingRelease(target, stageDir, tag)
  }
  console.log('\npublished:')
  for (const target of config.targets!) {
    const host = hostOf(target)
    console.log(`  ${host.kind} → ${host.downloadBase}/${tag}/（plugins.feedUrl 与 update.feedUrl 同址）`)
  }
}

// Run only when invoked directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(cause => {
    console.error(cause)
    process.exitCode = 1
  })
}
