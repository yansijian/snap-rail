/**
 * The `snap-rail-plugin dev` engine: watch-build a plugin project and
 * hot-sync the built faces into a real terminal home's plugin pool. Dev and
 * production share the mounting path — the pool is a directory, the zip is
 * just transport — so the host's pool watcher recomposes on every sync and
 * the renderer windows reload through the `client-config/changed` nudge.
 *
 * Sessions are restorative: an installed release copy sitting in the pool
 * moves aside before the first sync and moves back when the session ends
 * (Ctrl+C, or the next session / `--reset` after a crash), so a dev loop
 * never leaves a dev build behind.
 *
 * @module @snap-rail/plugin-sdk/dev
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import { load, dump } from 'js-yaml'
import { definePluginManifest } from './index.ts'

/** Name of the restorative-session journal inside `<home>/.dev-stage/`. */
export interface DevSessionMarker {
  /** The plugin's package name (the row and pool key). */
  name: string
  /** The user-layer row as it was before the session (null = no row). */
  previous: { row: Record<string, unknown> | null, index: number }
  /** Absolute path of the moved-aside release copy, or null. */
  backup: string | null
  /** Whether `plugins.yml` existed before the session created it. */
  userLayerExisted: boolean
}

/** Options for {@link runDev}. */
export interface DevOptions {
  /** Target home directory; defaults to the installed terminal's home. */
  home?: string | undefined
  /** Launch the installed terminal after the first sync: `true` for
   * auto-discovery, or an explicit executable path. */
  launch?: boolean | string | undefined
  /** Restore a leftover session (or an explicit teardown) and exit. */
  reset?: boolean
  /** One sync then exit, keeping the dev copy (scripting); default false. */
  noWatch?: boolean
}

const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50
const SETTLE_DEBOUNCE_MS = 300

/** Windows-busy errors a watching process (the terminal, an antivirus scan)
 * can raise while the pool directory is being swapped. */
function retryableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

function withRetries(action: () => void): void {
  for (let retry = 0; ; retry++) {
    try {
      action()
      return
    } catch (error) {
      if (!retryableFsError(error) || retry >= WRITE_RETRY_LIMIT) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRY_DELAY_MS)
    }
  }
}

/** Write a file atomically (land bytes in a sibling temp, rename over). */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  withRetries(() => renameSync(tmp, path))
}

/** The pool directory name for a package (`@scope/pkg` → `@scope__pkg`). */
export function poolDirName(name: string): string {
  return name.replaceAll('/', '__')
}

/** Whether two paths name the same location (case-insensitive on Windows). */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const left = resolve(a).replaceAll('\\', '/')
  const right = resolve(b).replaceAll('\\', '/')
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * The installed terminal's fixed home (`app.setPath('userData', …)` in the
 * desktop main entry): `%APPDATA%\snap-rail` on Windows, the conventional
 * application-support/config directories elsewhere.
 *
 * @param platform - `process.platform` (injected for tests).
 * @param env - `process.env` (injected for tests).
 * @returns the absolute home path.
 */
export function defaultInstalledHome(platform: string, env: Record<string, string | undefined>): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(env.USERPROFILE ?? '.', 'AppData', 'Roaming'), 'snap-rail')
  if (platform === 'darwin') return join(env.HOME ?? '.', 'Library', 'Application Support', 'snap-rail')
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '.', '.config'), 'snap-rail')
}

/** Parse `reg query … /v <name>` output into the value's string data. */
export function parseRegQueryValue(stdout: string, name: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line)
    if (match !== null && match[1] === name) return match[2]
  }
  return undefined
}

/** Parse `reg query … /v InstallLocation` output into the install directory. */
export function parseRegQueryInstallLocation(stdout: string): string | undefined {
  return parseRegQueryValue(stdout, 'InstallLocation')
}

/** Parse `reg query … /v DisplayName` output into the displayed product name. */
export function parseRegQueryDisplayName(stdout: string): string | undefined {
  return parseRegQueryValue(stdout, 'DisplayName')
}

/** Parse a bare `reg query <key>` enumeration into the child key paths. */
export function parseRegQuerySubKeys(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^HKEY_(CURRENT_USER|LOCAL_MACHINE)\\/i.test(line))
}

/** A process runner shaped like `execFileSync` with string output. */
type RegistryExec = (file: string, args: readonly string[], options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) => string

/**
 * The `reg query` reader the install probe uses; the executor is injected
 * so tests pin the real invocation shape (`reg query <args…>`).
 */
export function registryQueryWith(exec: RegistryExec = execFileSync): (args: string[]) => string | undefined {
  return args => {
    try {
      return exec('reg', ['query', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return undefined
    }
  }
}

/**
 * The NSIS uninstall keys live under a UUIDv5 of the app id (electron-builder
 * writes `Uninstall\<guid>`, not `Uninstall\<appId>`), so the key name cannot
 * be guessed — the uninstall roots are enumerated and matched by
 * DisplayName instead. HKLM covers a per-machine install.
 */
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/**
 * The exe paths an uninstall entry names. The per-user NSIS entry carries no
 * InstallLocation in practice; what it reliably writes is DisplayIcon
 * (`<dir>\snap-rail.exe,0`) and UninstallString
 * (`"<dir>\Uninstall snap-rail.exe" /currentuser`).
 */
function installedExeCandidates(key: string, registryQuery: (args: string[]) => string | undefined): string[] {
  const read = (name: string): string | undefined => parseRegQueryValue(registryQuery([key, '/v', name]) ?? '', name)
  const candidates: string[] = []
  const location = read('InstallLocation')
  if (location !== undefined) candidates.push(join(location, 'snap-rail.exe'))
  const icon = /^"?(.*?)"?(?:,-?\d+)?$/.exec(read('DisplayIcon') ?? '')?.[1]
  if (icon !== undefined && win32.basename(icon).toLowerCase() === 'snap-rail.exe') candidates.push(icon)
  const uninstall = read('UninstallString')
  const uninstaller = uninstall === undefined ? undefined : /^"([^"]+)"/.exec(uninstall)?.[1] ?? uninstall.split(' ')[0]
  if (uninstaller !== undefined && uninstaller !== '') candidates.push(join(win32.dirname(uninstaller), 'snap-rail.exe'))
  return [...new Set(candidates)]
}

/**
 * Locate the installed terminal executable: the uninstall registry entry's
 * InstallLocation (the installer allows a custom directory, so it is the
 * authority), else the default per-user path.
 *
 * @param platform - `process.platform` (injected for tests).
 * @param env - `process.env` (injected for tests).
 * @param explicit - an explicit executable path from `--launch <path>`.
 * @param registryQuery - the registry reader: runs `reg query <args…>` and
 *   returns its output, `undefined` on failure (injected for tests).
 * @returns the executable path, or the probed locations when none exists.
 */
export function findInstalledAppExe(
  platform: string,
  env: Record<string, string | undefined>,
  explicit?: string,
  registryQuery: (args: string[]) => string | undefined = registryQueryWith(),
): { exe: string } | { missing: string[] } {
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit) ? { exe: explicit } : { missing: [explicit] }
  }
  if (platform !== 'win32') return { missing: [] }
  const probed: string[] = []
  for (const root of UNINSTALL_ROOTS) {
    const listed = registryQuery([root])
    if (listed === undefined) continue
    for (const child of parseRegQuerySubKeys(listed)) {
      const displayName = parseRegQueryDisplayName(registryQuery([child, '/v', 'DisplayName']) ?? '')
      // electron-builder writes `<productName> <version>` ("snap-rail 0.6.0").
      if (displayName === undefined || !/^snap-rail(?:\s|$)/i.test(displayName)) continue
      for (const exe of installedExeCandidates(child, registryQuery)) {
        probed.push(exe)
        if (existsSync(exe)) return { exe }
      }
    }
  }
  const fallback = join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? '.', 'AppData', 'Local'), 'Programs', 'snap-rail', 'snap-rail.exe')
  probed.push(fallback)
  return existsSync(fallback) ? { exe: fallback } : { missing: probed }
}

/** Launch the terminal detached: the CLI's exit (Ctrl+C included) must not
 * take the app down, and the app's own single-instance lock makes a second
 * launch focus the first window instead of opening a new one. */
export function launchTerminal(exe: string): void {
  spawn(exe, { detached: true, stdio: 'ignore' }).unref()
}

/** One row of `plugins.yml` as loose data (config shape is the row's own). */
type LooseRow = Record<string, unknown> & { name?: unknown }

function readUserRows(userLayerPath: string): LooseRow[] {
  if (!existsSync(userLayerPath)) return []
  const parsed = load(readFileSync(userLayerPath, 'utf8')) as { plugins?: unknown } | null | undefined
  const plugins = parsed === null || parsed === undefined ? undefined : parsed.plugins
  return Array.isArray(plugins) ? plugins as LooseRow[] : []
}

function writeUserRows(userLayerPath: string, rows: readonly LooseRow[]): void {
  atomicWrite(userLayerPath, dump({ plugins: rows }))
}

/** Upsert `{ name, enabled: true }`, preserving the row's other fields
 * (config, annotations); other rows are untouched. */
export function upsertEnabledRow(userLayerPath: string, name: string): void {
  const rows = [...readUserRows(userLayerPath)]
  const index = rows.findIndex(row => row.name === name)
  if (index === -1) rows.push({ name, enabled: true })
  else rows[index] = { ...rows[index], enabled: true }
  writeUserRows(userLayerPath, rows)
}

/** Files a dev copy never carries even inside a face directory (the same
 * plumbing the release packer excludes). */
function isBuildPlumbing(path: string): boolean {
  return path.endsWith('.d.ts') || path.endsWith('.d.ts.map') || path.endsWith('.js.map')
    || path.endsWith('.tsbuildinfo')
}

/** The pool reads `name`/`main`/`snapRail`/`exports` only; the npm manifest's
 * scripts and dev dependencies are workspace plumbing. Subpath exports keep
 * the standard conditional shape in source — flatten to the `default` target
 * exactly like the packer does, so pool subpath resolution sees strings. */
function devPoolManifest(source: Record<string, unknown>, faceDirs: readonly string[]): Record<string, unknown> {
  const snapRail = source.snapRail
  const clientOnly = (snapRail as { clientOnly?: unknown } | undefined)?.clientOnly === true
  const client = (snapRail as { client?: { entry?: unknown } } | undefined)?.client
  const clientEntry = typeof client?.entry === 'string' ? client.entry : undefined
  const main = clientOnly && clientEntry !== undefined
    ? clientEntry
    : typeof source.main === 'string' && source.main !== '' ? source.main : 'lib-host/host.js'
  const exports = typeof source.exports === 'object' && source.exports !== null
    ? Object.fromEntries(Object.entries(source.exports as Record<string, unknown>).flatMap(([key, value]): Array<[string, string]> => {
        if (key === '.' || key === './package.json') return []
        const raw = typeof value === 'string'
          ? value
          : value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).default === 'string'
            ? (value as { default: string }).default
            : undefined
        const target = raw?.replace(/^\.\//, '')
        if (target === undefined || !faceDirs.some(dir => target.startsWith(`${dir}/`))) return []
        return [[key, target]]
      }))
    : undefined
  return {
    name: source.name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    type: 'module',
    main,
    ...(Object.keys(exports ?? {}).length > 0 ? { exports } : {}),
    ...(snapRail !== undefined ? { snapRail } : {}),
  }
}

/** Stage the dev copy outside the pool (a package directory inside the pool
 * would be scanned the moment it carries a package.json): the trimmed
 * manifest plus every face directory's build output. */
export function stageDevPackage(root: string, stageDir: string): void {
  rmSync(stageDir, { recursive: true, force: true, maxRetries: WRITE_RETRY_LIMIT, retryDelay: WRITE_RETRY_DELAY_MS })
  mkdirSync(stageDir, { recursive: true })
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  // Validate before anything lands: the pool must never see a malformed copy.
  definePluginManifest(source)
  const snapRail = source.snapRail as { clientOnly?: unknown, client?: { entry?: unknown } } | undefined
  const clientEntry = typeof snapRail?.client?.entry === 'string' ? snapRail.client.entry : undefined
  const hostDir = snapRail?.clientOnly === true
    ? undefined
    : dirname(typeof source.main === 'string' && source.main !== '' ? source.main : 'lib-host/host.js')
  const clientFace = clientEntry === undefined ? undefined : dirname(clientEntry)
  const faceDirs = [hostDir, clientFace].filter((dir): dir is string => dir !== undefined)
  for (const dir of faceDirs) {
    if (!existsSync(join(root, dir))) continue
    cpSync(join(root, dir), join(stageDir, dir), {
      recursive: true,
      filter: sourcePath => !isBuildPlumbing(sourcePath),
    })
  }
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(devPoolManifest(source, faceDirs), null, 2)}\n`)
}

/** Swap the staged copy into the pool as one top-level rename pair (rm +
 * rename): the host's pool watcher reacts to pool membership changes — a
 * whole-directory appearance — never to in-place file writes inside a live
 * pool package. */
export function swapIntoPool(stageDir: string, poolDir: string): void {
  rmSync(poolDir, { recursive: true, force: true, maxRetries: WRITE_RETRY_LIMIT, retryDelay: WRITE_RETRY_DELAY_MS })
  withRetries(() => renameSync(stageDir, poolDir))
}

function markerPathOf(home: string, name: string): string {
  return join(home, '.dev-stage', `${poolDirName(name)}.session.json`)
}

function readMarker(path: string): DevSessionMarker {
  return JSON.parse(readFileSync(path, 'utf8')) as DevSessionMarker
}

function writeMarker(path: string, marker: DevSessionMarker): void {
  mkdirSync(dirname(path), { recursive: true })
  atomicWrite(path, `${JSON.stringify(marker, null, 2)}\n`)
}

/**
 * Put the home back the way it was before the session: drop the dev copy,
 * move the release backup back into the pool, restore the user-layer row
 * (whole row, at its old position), and remove the journal. The renames are
 * the events the running terminal's watcher needs to recompose on its own.
 */
export function restoreSession(home: string, marker: DevSessionMarker): void {
  const poolDir = join(home, 'plugins', poolDirName(marker.name))
  rmSync(poolDir, { recursive: true, force: true, maxRetries: WRITE_RETRY_LIMIT, retryDelay: WRITE_RETRY_DELAY_MS })
  if (marker.backup !== null && existsSync(marker.backup)) {
    withRetries(() => renameSync(marker.backup!, poolDir))
  }
  const userLayerPath = join(home, 'plugins.yml')
  const rows = readUserRows(userLayerPath).filter(row => row.name !== marker.name)
  if (marker.previous.row !== null) {
    rows.splice(Math.min(marker.previous.index, rows.length), 0, marker.previous.row)
  }
  if (rows.length > 0) writeUserRows(userLayerPath, rows)
  else if (!marker.userLayerExisted && existsSync(userLayerPath)) rmSync(userLayerPath, { force: true })
  const path = markerPathOf(home, marker.name)
  if (existsSync(path)) rmSync(path, { force: true })
  const stageDir = join(home, '.dev-stage', poolDirName(marker.name))
  rmSync(stageDir, { recursive: true, force: true })
  // Leave no empty session scaffolding behind (other packages' sessions keep
  // theirs: only empty directories go).
  for (const dir of [join(home, '.dev-stage', 'backup'), join(home, '.dev-stage')]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  }
}

/** Recursively watch directories and report settled change bursts; falls
 * back to 1s mtime polling where recursive `fs.watch` is unavailable. */
export function watchSettled(dirs: readonly string[], onChange: () => void, debounceMs = SETTLE_DEBOUNCE_MS): () => void {
  let timer: NodeJS.Timeout | undefined
  const fire = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, debounceMs)
  }
  const closers: Array<() => void> = []
  const snapshot = (dir: string): string => {
    const parts: string[] = []
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) walk(join(current, entry.name), rel)
        else if (entry.isFile()) {
          try {
            const stat = statSync(join(current, entry.name))
            parts.push(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`)
          } catch {
            parts.push(`${rel}:gone`)
          }
        }
      }
    }
    walk(dir, '')
    return createHash('sha1').update(parts.join('|')).digest('hex')
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      const watcher = watch(dir, { recursive: true }, () => fire())
      closers.push(() => watcher.close())
    } catch {
      // Recursive watch unsupported here: poll instead (identity by stat
      // fingerprint, so identical rewrites do not fire).
      const state = { digest: snapshot(dir) }
      const interval = setInterval(() => {
        const digest = snapshot(dir)
        if (digest !== state.digest) {
          state.digest = digest
          fire()
        }
      }, 1000)
      closers.push(() => clearInterval(interval))
    }
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    for (const close of closers.splice(0)) close()
  }
}

/** Run the local tsdown binary (`node_modules/.bin`) in the project; the
 * Windows shim is a `.cmd`, so it goes through a shell. */
function spawnTsdown(root: string, args: readonly string[]): ChildProcess {
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
  if (!existsSync(bin)) throw new Error(`dev: ${bin} 不存在 —— 先在插件仓 pnpm install`)
  if (process.platform === 'win32') {
    return spawn(`"${bin}" ${args.join(' ')}`, { shell: true, stdio: 'inherit', cwd: root })
  }
  return spawn(bin, [...args], { stdio: 'inherit', cwd: root })
}

/**
 * Run a dev session over a plugin project directory. See the module doc for
 * the session contract; `options.reset` short-circuits into a restore.
 *
 * @throws on contract violations (missing manifest, missing tsdown, a
 * `--launch` that cannot resolve, …) — always before the home is touched,
 * except where noted.
 */
export async function runDev(directory: string, options: DevOptions): Promise<void> {
  const root = resolve(directory)
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`dev: ${manifestPath} 不存在`)
  const source = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const manifest = definePluginManifest(source)
  const home = resolve(options.home ?? defaultInstalledHome(process.platform, process.env))
  const markerPath = markerPathOf(home, manifest.name)
  const poolDir = join(home, 'plugins', poolDirName(manifest.name))
  const stageDir = join(home, '.dev-stage', poolDirName(manifest.name))

  if (options.reset === true) {
    if (!existsSync(markerPath)) {
      console.log(`没有可恢复的 dev 会话（${markerPath} 不存在）`)
      return
    }
    restoreSession(home, readMarker(markerPath))
    console.log(`已恢复 ${manifest.name} 会话前的原状（${home}）`)
    return
  }

  // A crashed session leaves its journal behind; the next session recovers
  // the home before taking over.
  if (existsSync(markerPath)) {
    const leftover = readMarker(markerPath)
    restoreSession(home, leftover)
    console.log(`检测到上次 dev 会话的残留，已恢复原状（${leftover.name}）`)
  }

  // --launch only ever names the installed terminal, whose home is fixed —
  // syncing anywhere else would be silently invisible to it.
  if (options.launch !== undefined && options.launch !== false) {
    const defaultHome = defaultInstalledHome(process.platform, process.env)
    if (!samePath(home, defaultHome)) {
      throw new Error(`dev: --launch 只在目标是安装版 home（${defaultHome}）时可用——安装版 exe 的 home 固定，同步到 ${home} 它看不见`)
    }
  }

  console.log(`home: ${home}`)
  mkdirSync(join(home, 'plugins'), { recursive: true })
  const userLayerPath = join(home, 'plugins.yml')

  // One sync needs built faces; build once up front (fail here = nothing in
  // the home has been touched yet except the plugins/ directory).
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawnTsdown(root, [])
    child.on('error', rejectRun)
    child.on('exit', code => (code === 0 ? resolveRun() : rejectRun(new Error(`dev: 构建失败（exit ${code}）——未改动 home`))))
  })

  const rows = readUserRows(userLayerPath)
  const previousIndex = rows.findIndex(row => row.name === manifest.name)
  const backupRoot = join(home, '.dev-stage', 'backup')
  const backup = existsSync(poolDir) ? join(backupRoot, poolDirName(manifest.name)) : null
  if (backup !== null) {
    mkdirSync(backupRoot, { recursive: true })
    rmSync(backup, { recursive: true, force: true, maxRetries: WRITE_RETRY_LIMIT, retryDelay: WRITE_RETRY_DELAY_MS })
    withRetries(() => renameSync(poolDir, backup))
  }
  writeMarker(markerPath, {
    name: manifest.name,
    previous: {
      row: previousIndex === -1 ? null : { ...rows[previousIndex]! },
      index: previousIndex === -1 ? rows.length : previousIndex,
    },
    backup,
    userLayerExisted: existsSync(userLayerPath),
  })

  const sync = (): void => {
    stageDevPackage(root, stageDir)
    swapIntoPool(stageDir, poolDir)
    console.log(`已同步 ${manifest.name} → ${poolDir}（客户端运行中即热生效，未运行则下次启动生效）`)
  }
  sync()
  upsertEnabledRow(userLayerPath, manifest.name)

  if (options.launch !== undefined && options.launch !== false) {
    const explicit = typeof options.launch === 'string' ? options.launch : undefined
    const found = findInstalledAppExe(process.platform, process.env, explicit)
    if ('exe' in found) {
      launchTerminal(found.exe)
      console.log(`已拉起客户端（${found.exe}；已在运行时仅聚焦现有窗口）`)
    } else {
      const probed = found.missing.length > 0 ? `，探测过：${found.missing.join('、')}` : '（此平台需显式路径）'
      console.log(`未找到客户端可执行文件，仅继续同步；可用 --launch <exe 路径> 直接指定${probed}`)
    }
  }

  if (options.noWatch === true) {
    console.log('单次同步完成（--no-watch 保留 dev 副本；snap-rail-plugin dev . --reset 恢复原状）')
    return
  }

  const snapRail = source.snapRail as { clientOnly?: unknown, client?: { entry?: unknown } } | undefined
  const clientEntry = typeof snapRail?.client?.entry === 'string' ? snapRail.client.entry : undefined
  const hostDir = snapRail?.clientOnly === true
    ? undefined
    : dirname(typeof source.main === 'string' && source.main !== '' ? source.main : 'lib-host/host.js')
  const watchDirs = [hostDir, clientEntry === undefined ? undefined : dirname(clientEntry)]
    .map(dir => (dir === undefined ? undefined : join(root, dir)))
    .filter((dir): dir is string => dir !== undefined && existsSync(dir))

  const stopWatch = watchSettled(watchDirs, sync)
  const builder = spawnTsdown(root, ['--watch'])
  let finished = false
  const finish = (code: number): void => {
    if (finished) return
    finished = true
    stopWatch()
    builder.kill()
    // The marker is already gone when a concurrent exit path restored first.
    if (existsSync(markerPath)) restoreSession(home, readMarker(markerPath))
    console.log(`已恢复 ${manifest.name} 会话前的原状（${home}）`)
    process.exit(code)
  }
  process.once('SIGINT', () => finish(0))
  process.once('SIGTERM', () => finish(0))
  // The builder exiting ends the session (a failed config, a kill): a dev
  // loop without a builder is a stale pool copy, so it ends restored.
  builder.on('exit', code => finish(code ?? 0))
  console.log('dev 会话进行中：保存源码 → 自动构建同步 → 客户端热生效；Ctrl+C 结束并恢复原状')
  await new Promise(() => {})
}
