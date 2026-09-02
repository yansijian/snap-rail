import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { InstallError, installPluginFromZip, pluginDataFile, uninstallPlugin } from '../src/installer.ts'

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

  it('refuses to overwrite an installed package (uninstall first)', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    const zip = makeZip({ 'p/package.json': MANIFEST })
    installPluginFromZip(zip, pool)
    try {
      installPluginFromZip(zip, pool)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
    }
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
