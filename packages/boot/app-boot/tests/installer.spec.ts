import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { compareVersions, InstallError, installPluginFromZip, installedVersionOf, pluginDataFile, uninstallPlugin } from '../src/installer.ts'

function makeZip(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-rail-zip-'))
  const path = join(dir, 'plugin.zip')
  const encoded: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    encoded[name] = new TextEncoder().encode(content)
  }
  writeFileSync(path, zipSync(encoded))
  return path
}

const MANIFEST = JSON.stringify({
  name: '@scope/demo-plugin',
  version: '1.2.3',
  type: 'module',
  main: 'lib/index.js',
  snapRail: { kind: 'driver', permissions: ['net:demo'] },
})

/** One install zip for `@scope/demo-plugin` at the given version, with a
 * version-tagged entry file so overwrite tests can see the swap. */
function demoZip(version: string, entryName: string): string {
  return makeZip({
    'demo-plugin/package.json': JSON.stringify({
      name: '@scope/demo-plugin', version, type: 'module', main: `lib/${entryName}`,
    }),
    [`demo-plugin/lib/${entryName}`]: `export default { version: "${version}" }`,
  })
}

describe('compareVersions', () => {
  it('orders numeric segments numerically, not lexicographically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('0.9', '1.0')).toBeLessThan(0)
  })

  it('orders a prerelease before its release and compares identifiers', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBeLessThan(0)
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-beta', '1.2.3-alpha')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-2', '1.2.3-10')).toBeLessThan(0)
  })
})

describe('installedVersionOf', () => {
  it('reads the declared version and reports absent or broken installs', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBeUndefined()
    installPluginFromZip(makeZip({ 'p/package.json': MANIFEST }), pool)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.2.3')
    // A broken manifest reads as 0.0.0: any real version may repair it.
    writeFileSync(join(pool, '@scope__demo-plugin', 'package.json'), '{ broken')
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('0.0.0')
    rmSync(base, { recursive: true, force: true })
  })
})

describe('plugin installer', () => {
  it('installs a single-root zip into the pool and reports the package', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({
      'demo-plugin/package.json': MANIFEST,
      'demo-plugin/lib/index.js': 'export default { name: "demo", apply() {} }',
    })
    const result = installPluginFromZip(zip, join(base, 'plugins'))
    expect(result.name).toBe('@scope/demo-plugin')
    expect(result.version).toBe('1.2.3')
    expect(result.updated).toBe(false)
    const entry = readFileSync(join(result.dir, 'lib', 'index.js'), 'utf8')
    expect(entry).toContain('apply()')
    expect(result.dir.startsWith(join(base, 'plugins'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('installs a zip whose package sits at the archive root', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({ 'package.json': MANIFEST })
    const result = installPluginFromZip(zip, join(base, 'plugins'))
    expect(existsSync(join(result.dir, 'package.json'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('rejects zips without a manifest and illegal names', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const noManifest = makeZip({ 'lib/index.js': 'x' })
    expect(() => installPluginFromZip(noManifest, join(base, 'plugins'))).toThrow(InstallError)
    try {
      installPluginFromZip(noManifest, join(base, 'plugins'))
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    const badName = makeZip({ 'p/package.json': JSON.stringify({ name: 'Not A Name' }) })
    try {
      installPluginFromZip(badName, join(base, 'plugins'))
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    const badKind = makeZip({ 'p/package.json': JSON.stringify({ name: 'ok-name', snapRail: { kind: 'Not Kebab' } }) })
    try {
      installPluginFromZip(badKind, join(base, 'plugins'))
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('updates an installed package in place when the zip is strictly higher', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    const home = join(base, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })

    const v1 = installPluginFromZip(demoZip('1.0.0', 'old.js'), pool)
    // The update must not touch the package's namespaced data.
    const data = pluginDataFile(home, '@scope/demo-plugin')
    writeFileSync(data, 'x')

    const v2 = installPluginFromZip(demoZip('1.1.0', 'new.js'), pool)
    expect(v2.updated).toBe(true)
    expect(v2.dir).toBe(v1.dir)
    // The swap replaced the tree: new content in, dropped files gone.
    expect(readFileSync(join(v2.dir, 'lib', 'new.js'), 'utf8')).toContain('1.1.0')
    expect(existsSync(join(v2.dir, 'lib', 'old.js'))).toBe(false)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.1.0')
    // No staging directory is left behind in the pool.
    expect(readdirSync(pool).filter(name => name.includes('.update-'))).toEqual([])
    expect(existsSync(data)).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('refuses to update when the zip version is not strictly higher', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    installPluginFromZip(demoZip('1.2.3', 'index.js'), pool)
    // Equal version: reinstalling is refused.
    try {
      installPluginFromZip(demoZip('1.2.3', 'index.js'), pool)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
      expect((cause as InstallError).message).toContain('1.2.3')
    }
    // Lower version: downgrading goes through an explicit uninstall.
    try {
      installPluginFromZip(demoZip('1.0.0', 'old.js'), pool)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
    }
    // The refused attempts left the installed copy intact.
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.2.3')
    rmSync(base, { recursive: true, force: true })
  })

  it('repairs a broken install: an unreadable manifest counts as 0.0.0', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    installPluginFromZip(demoZip('1.0.0', 'index.js'), pool)
    writeFileSync(join(pool, '@scope__demo-plugin', 'package.json'), '{ broken')
    const repaired = installPluginFromZip(demoZip('1.0.0', 'index.js'), pool)
    expect(repaired.updated).toBe(true)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.0.0')
    rmSync(base, { recursive: true, force: true })
  })

  it('uninstalls the pool directory and the namespaced data files', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    const home = join(base, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })
    const zip = makeZip({ 'p/package.json': MANIFEST })
    const installed = installPluginFromZip(zip, pool)
    const data = pluginDataFile(home, '@scope/demo-plugin')
    writeFileSync(data, 'x')
    writeFileSync(`${data}-wal`, 'y')

    uninstallPlugin('@scope/demo-plugin', pool, home)
    expect(existsSync(installed.dir)).toBe(false)
    expect(existsSync(data)).toBe(false)
    expect(existsSync(`${data}-wal`)).toBe(false)
    try {
      uninstallPlugin('@scope/demo-plugin', pool, home)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('not-installed')
    }
    rmSync(base, { recursive: true, force: true })
  })
})
