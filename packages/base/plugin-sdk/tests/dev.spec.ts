import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
// The acceptance oracle: whatever the dev sync lands must be discoverable by
// the host's own pool scanner (same scan the terminal runs).
import { scanPluginPool } from '../../app-boot/src/scan.ts'
import {
  defaultInstalledHome,
  findInstalledAppExe,
  parseRegQueryDisplayName,
  parseRegQueryInstallLocation,
  parseRegQuerySubKeys,
  parseRegQueryValue,
  registryQueryWith,
  restoreSession,
  runDev,
  samePath,
  stageDevPackage,
  swapIntoPool,
  upsertEnabledRow,
  type DevSessionMarker,
} from '../src/dev.ts'

const roots: string[] = []

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

afterEach(() => {
  vi.clearAllMocks()
})

function rowsOf(path: string): Array<Record<string, unknown>> {
  return ((load(readFileSync(path, 'utf8')) as { plugins?: unknown[] }).plugins ?? []) as Array<Record<string, unknown>>
}

/** A built dual-face plugin project (what `tsdown` leaves behind). */
function seedProject(options: { clientOnly?: boolean } = {}): string {
  const root = join(tempRoot('sdk-dev-project'), 'demo')
  mkdirSync(join(root, 'lib-host'), { recursive: true })
  mkdirSync(join(root, 'lib-client', 'assets'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const snapRail = options.clientOnly === true
    ? { kind: 'plugin', layer: 'ui', title: 'Demo view', uiProfile: 'native', clientOnly: true, client: { entry: 'lib-client/client.js' } }
    : { kind: 'suite', layer: 'suite', title: 'Demo suite', uiProfile: 'native', exclusive: 'suite', client: { entry: 'lib-client/client.js' } }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@x/demo',
    version: '0.3.0',
    type: 'module',
    ...(options.clientOnly === true ? {} : { main: 'lib-host/host.js' }),
    scripts: { build: 'tsdown' },
    devDependencies: { tsdown: '^0.22.2' },
    exports: {
      '.': './lib-host/host.js',
      './rpc': { types: './lib-host/types/rpc.d.ts', default: './lib-host/rpc.js' },
      './package.json': './package.json',
    },
    snapRail,
  }))
  writeFileSync(join(root, 'lib-host', 'host.js'), 'export default { apply() {} }\n')
  writeFileSync(join(root, 'lib-host', 'rpc.js'), 'export default { apply() {} }\n')
  writeFileSync(join(root, 'lib-host', 'host.d.ts'), 'export {}\n')
  writeFileSync(join(root, 'lib-host', 'host.js.map'), '{}\n')
  writeFileSync(join(root, 'lib-client', 'client.js'), '/* client */\n')
  writeFileSync(join(root, 'lib-client', 'assets', 'logo.svg'), '<svg/>')
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
  return root
}

describe('dev home and launch discovery', () => {
  it('names the installed terminal home per platform', () => {
    const appData = join('C:', 'Users', 'op', 'AppData', 'Roaming')
    expect(defaultInstalledHome('win32', { APPDATA: appData })).toBe(join(appData, 'snap-rail'))
    expect(defaultInstalledHome('darwin', { HOME: '/Users/op' })).toBe(join('/Users/op', 'Library', 'Application Support', 'snap-rail'))
    expect(defaultInstalledHome('linux', { HOME: '/home/op' })).toBe(join('/home/op', '.config', 'snap-rail'))
    expect(defaultInstalledHome('linux', { HOME: '/home/op', XDG_CONFIG_HOME: '/cfg' })).toBe(join('/cfg', 'snap-rail'))
  })

  it('compares homes case-insensitively on Windows only', () => {
    expect(samePath('C:\\Users\\Op\\AppData', 'c:/users/op/appdata', 'win32')).toBe(true)
    expect(samePath('/tmp/Home', '/tmp/home', 'linux')).toBe(false)
  })

  it('parses the uninstall key InstallLocation (spaces kept)', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\io.snaprail.desktop',
      '    InstallLocation    REG_SZ    D:\\Program Files\\snap rail',
      '',
    ].join('\r\n')
    expect(parseRegQueryInstallLocation(stdout)).toBe('D:\\Program Files\\snap rail')
    expect(parseRegQueryInstallLocation('ERROR: The system was unable to find the specified registry key')).toBeUndefined()
  })

  it('parses the uninstall key InstallLocation (spaces kept)', () => {
    const stdout = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\io.snaprail.desktop',
      '    InstallLocation    REG_SZ    D:\\Program Files\\snap rail',
      '',
    ].join('\r\n')
    expect(parseRegQueryInstallLocation(stdout)).toBe('D:\\Program Files\\snap rail')
    expect(parseRegQueryInstallLocation('ERROR: The system was unable to find the specified registry key')).toBeUndefined()
  })

  it('parses reg enumeration and value output', () => {
    const enumeration = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{2f0e4a52-1}',
      '',
      '    (默认)    REG_SZ    ',
    ].join('\r\n')
    expect(parseRegQuerySubKeys(enumeration)).toEqual(['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{2f0e4a52-1}'])
    expect(parseRegQueryDisplayName('    DisplayName    REG_SZ    snap-rail 0.6.0\r\n')).toBe('snap-rail 0.6.0')
    expect(parseRegQueryValue('    DisplayIcon    REG_EXPAND_SZ    C:\\x\\snap-rail.exe,0\r\n', 'DisplayIcon')).toBe('C:\\x\\snap-rail.exe,0')
    expect(parseRegQueryDisplayName('ERROR: The system was unable to find the specified registry key')).toBeUndefined()
  })

  it('runs the registry reader as `reg query <args>`', () => {
    const seen: string[][] = []
    const query = registryQueryWith((file, args) => {
      seen.push([file, ...args])
      return 'ok'
    })
    expect(query(['HKCU\\X', '/v', 'DisplayName'])).toBe('ok')
    expect(seen).toEqual([['reg', 'query', 'HKCU\\X', '/v', 'DisplayName']])
    expect(registryQueryWith(() => {
      throw new Error('missing key')
    })(['HKCU\\Y'])).toBeUndefined()
  })

  it('finds the exe: explicit path, the uninstall entry, then the default per-user path', () => {
    const root = tempRoot('sdk-dev-exe')
    const explicit = join(root, 'custom.exe')
    writeFileSync(explicit, '')
    expect(findInstalledAppExe('win32', {}, explicit, () => undefined)).toEqual({ exe: explicit })
    expect(findInstalledAppExe('win32', {}, join(root, 'absent.exe'), () => undefined))
      .toEqual({ missing: [join(root, 'absent.exe')] })

    // The real per-user NSIS entry (captured from an install in a custom
    // directory): a UUIDv5 key, a versioned DisplayName, and NO
    // InstallLocation — DisplayIcon and UninstallString carry the directory.
    // `reg query` echoes keys in their long HKEY_* form.
    const installed = join(root, 'Software', 'snap-rail')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'snap-rail.exe'), '')
    const queryRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    const listedKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\f1cb149d-3093-5ef7-adc8-98908d96b731'
    const foreignKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{9adedd55-2}'
    const registry: Record<string, string> = {
      [queryRoot]: [listedKey, foreignKey].join('\r\n'),
      [`${listedKey} /v DisplayName`]: '    DisplayName    REG_SZ    snap-rail 0.6.0\r\n',
      [`${listedKey} /v DisplayIcon`]: `    DisplayIcon    REG_SZ    ${join(installed, 'snap-rail.exe')},0\r\n`,
      [`${listedKey} /v UninstallString`]: `    UninstallString    REG_SZ    "${join(installed, 'Uninstall snap-rail.exe')}" /currentuser\r\n`,
      [`${foreignKey} /v DisplayName`]: '    DisplayName    REG_SZ    snap-rail-like 9\r\n',
    }
    expect(findInstalledAppExe('win32', {}, undefined, args => registry[args.join(' ')]))
      .toEqual({ exe: join(installed, 'snap-rail.exe') })

    // UninstallString alone still names the directory.
    const { [`${listedKey} /v DisplayIcon`]: _icon, ...withoutIcon } = registry
    expect(findInstalledAppExe('win32', {}, undefined, args => withoutIcon[args.join(' ')]))
      .toEqual({ exe: join(installed, 'snap-rail.exe') })

    // An entry that does write InstallLocation is honoured first.
    const located = join(root, 'chosen dir')
    mkdirSync(located, { recursive: true })
    writeFileSync(join(located, 'snap-rail.exe'), '')
    const withLocation = { ...registry, [`${listedKey} /v InstallLocation`]: `    InstallLocation    REG_SZ    ${located}\r\n` }
    expect(findInstalledAppExe('win32', {}, undefined, args => withLocation[args.join(' ')]))
      .toEqual({ exe: join(located, 'snap-rail.exe') })

    // No usable uninstall entry (empty roots): the default per-user install path.
    const local = join(root, 'local')
    mkdirSync(join(local, 'Programs', 'snap-rail'), { recursive: true })
    writeFileSync(join(local, 'Programs', 'snap-rail', 'snap-rail.exe'), '')
    expect(findInstalledAppExe('win32', { LOCALAPPDATA: local }, undefined, () => undefined))
      .toEqual({ exe: join(local, 'Programs', 'snap-rail', 'snap-rail.exe') })

    // Nothing anywhere: the probed locations are the report.
    const nowhere = join(root, 'nowhere')
    expect(findInstalledAppExe('win32', { LOCALAPPDATA: nowhere }, undefined, () => undefined))
      .toEqual({ missing: [join(nowhere, 'Programs', 'snap-rail', 'snap-rail.exe')] })
    // Other platforms auto-discover nothing (explicit paths only).
    expect(findInstalledAppExe('linux', {}, undefined, () => 'HKEY_CURRENT_USER\\x')).toEqual({ missing: [] })
  })
})

describe('dev rows, staging, and the pool swap', () => {
  it('upserts the enabled row without touching other rows or the row config', () => {
    const home = tempRoot('sdk-dev-rows')
    const path = join(home, 'plugins.yml')
    upsertEnabledRow(path, '@x/demo')
    expect(rowsOf(path)).toEqual([{ name: '@x/demo', enabled: true }])

    writeFileSync(path, [
      'plugins:',
      "  - name: '@x/other'",
      '    enabled: false',
      "  - name: '@x/demo'",
      '    enabled: false',
      '    config:',
      '      interval: 250',
      '',
    ].join('\n'))
    upsertEnabledRow(path, '@x/demo')
    expect(rowsOf(path)).toEqual([
      { name: '@x/other', enabled: false },
      { name: '@x/demo', enabled: true, config: { interval: 250 } },
    ])
  })

  it('stages a trimmed manifest plus the built faces — never src, declarations, or maps', () => {
    const project = seedProject()
    const stage = join(tempRoot('sdk-dev-stage'), 'stage')
    stageDevPackage(project, stage)
    const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ name: '@x/demo', version: '0.3.0', type: 'module', main: 'lib-host/host.js' })
    // Workspace plumbing stays out; subpath exports flatten to strings so the
    // pool's subpath resolution can read them.
    expect(manifest.scripts).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.exports).toEqual({ './rpc': 'lib-host/rpc.js' })
    expect(existsSync(join(stage, 'lib-host', 'host.js'))).toBe(true)
    expect(existsSync(join(stage, 'lib-host', 'rpc.js'))).toBe(true)
    expect(existsSync(join(stage, 'lib-client', 'client.js'))).toBe(true)
    expect(existsSync(join(stage, 'lib-client', 'assets', 'logo.svg'))).toBe(true)
    expect(existsSync(join(stage, 'lib-host', 'host.d.ts'))).toBe(false)
    expect(existsSync(join(stage, 'lib-host', 'host.js.map'))).toBe(false)
    expect(existsSync(join(stage, 'src'))).toBe(false)
  })

  it('points a client-only copy at its client bundle', () => {
    const project = seedProject({ clientOnly: true })
    const stage = join(tempRoot('sdk-dev-stage-client'), 'stage')
    stageDevPackage(project, stage)
    const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.main).toBe('lib-client/client.js')
    expect(existsSync(join(stage, 'lib-host'))).toBe(false)
  })

  it('swaps into the pool where the host scanner discovers it; a rebuild changes the entry URL', () => {
    const project = seedProject()
    const home = tempRoot('sdk-dev-swap')
    const pool = join(home, 'plugins')
    const poolDir = join(pool, '@x__demo')
    const stage = join(home, '.dev-stage', '@x__demo')
    mkdirSync(pool, { recursive: true })

    stageDevPackage(project, stage)
    swapIntoPool(stage, poolDir)
    expect(existsSync(stage)).toBe(false)
    const first = scanPluginPool([pool]).get('@x/demo')
    expect(first).toBeDefined()
    expect(first!.clientEntry).toBe('lib-client/client.js')
    expect(first!.entryUrl).toContain('lib-host/host.js?v=')

    // The next settle after a rebuild: a whole-directory swap over the live
    // copy, and the host entry URL moves with the bytes.
    writeFileSync(join(project, 'lib-host', 'host.js'), 'export default { apply() {}, rebuilt: true }\n')
    stageDevPackage(project, stage)
    swapIntoPool(stage, poolDir)
    const second = scanPluginPool([pool]).get('@x/demo')
    expect(second!.entryUrl).not.toBe(first!.entryUrl)
  })
})

describe('restorative dev sessions', () => {
  /** A home mid-session: dev copy in the pool, the release copy parked in
   * the backup, the dev row enabled, the journal written. */
  function seedSession(options: { previousRow: Record<string, unknown> | null, userLayerExisted: boolean, otherRows?: boolean }): { home: string, marker: DevSessionMarker } {
    const home = tempRoot('sdk-dev-session')
    const poolDir = join(home, 'plugins', '@x__demo')
    mkdirSync(poolDir, { recursive: true })
    writeFileSync(join(poolDir, 'package.json'), JSON.stringify({ name: '@x/demo', version: '0.0.0-dev' }))
    let backup: string | null = null
    if (options.previousRow !== null) {
      backup = join(home, '.dev-stage', 'backup', '@x__demo')
      mkdirSync(backup, { recursive: true })
      writeFileSync(join(backup, 'package.json'), JSON.stringify({ name: '@x/demo', version: '1.0.0' }))
    }
    const rows = [
      ...(options.otherRows === true ? [{ name: '@x/other' }] : []),
      { name: '@x/demo', enabled: true },
    ]
    writeFileSync(join(home, 'plugins.yml'), `${JSON.stringify({ plugins: rows })}\n`)
    const marker: DevSessionMarker = {
      name: '@x/demo',
      previous: { row: options.previousRow, index: options.otherRows === true ? 1 : 0 },
      backup,
      userLayerExisted: options.userLayerExisted,
    }
    mkdirSync(join(home, '.dev-stage'), { recursive: true })
    writeFileSync(join(home, '.dev-stage', '@x__demo.session.json'), JSON.stringify(marker))
    return { home, marker }
  }

  it('moves the release copy back and restores the whole row at its old position', () => {
    const { home, marker } = seedSession({
      previousRow: { name: '@x/demo', enabled: false, config: { k: 1 } },
      userLayerExisted: true,
      otherRows: true,
    })
    restoreSession(home, marker)
    const restored = JSON.parse(readFileSync(join(home, 'plugins', '@x__demo', 'package.json'), 'utf8')) as { version: string }
    expect(restored.version).toBe('1.0.0')
    expect(existsSync(marker.backup!)).toBe(false)
    expect(rowsOf(join(home, 'plugins.yml'))).toEqual([
      { name: '@x/other' },
      { name: '@x/demo', enabled: false, config: { k: 1 } },
    ])
    expect(existsSync(join(home, '.dev-stage', '@x__demo.session.json'))).toBe(false)
    // No empty session scaffolding is left in the home.
    expect(existsSync(join(home, '.dev-stage'))).toBe(false)
  })

  it('removes the dev copy and the row when the session started from nothing', () => {
    const { home, marker } = seedSession({ previousRow: null, userLayerExisted: false })
    restoreSession(home, marker)
    expect(existsSync(join(home, 'plugins', '@x__demo'))).toBe(false)
    // The session created plugins.yml; with no rows left it goes away too.
    expect(existsSync(join(home, 'plugins.yml'))).toBe(false)
  })

  it('keeps the other rows when the user layer pre-existed', () => {
    const { home, marker } = seedSession({ previousRow: null, userLayerExisted: true, otherRows: true })
    restoreSession(home, marker)
    expect(rowsOf(join(home, 'plugins.yml'))).toEqual([{ name: '@x/other' }])
  })

  it('--reset restores a leftover session and reports when there is none', async () => {
    const project = seedProject()
    const { home } = seedSession({
      previousRow: { name: '@x/demo', enabled: true },
      userLayerExisted: true,
    })
    await runDev(project, { home, reset: true })
    expect(existsSync(join(home, '.dev-stage', '@x__demo.session.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(home, 'plugins', '@x__demo', 'package.json'), 'utf8'))).toMatchObject({ version: '1.0.0' })

    logSpy.mockClear()
    await runDev(project, { home, reset: true })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('没有可恢复的 dev 会话')
  })

  it('refuses --launch against a home the installed terminal never reads', async () => {
    const project = seedProject()
    const home = tempRoot('sdk-dev-launch')
    await expect(runDev(project, { home, launch: true })).rejects.toThrow(/--launch 只在目标是安装版 home/)
    // Refused before anything lands in the home.
    expect(existsSync(join(home, 'plugins'))).toBe(false)
  })
})
