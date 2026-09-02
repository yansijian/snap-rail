import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { installPluginFromZip } from '../../../boot/app-boot/src/installer.ts'
import { scanPluginPool } from '@snap-rail/app-boot/scan'
import { releaseFiles, releaseManifest, zipFileName, type ReleaseSpec } from '../src/pack.ts'

// The specs mirror scripts/pack-plugins.ts against the built workspace tree
// (pnpm test builds first); the round-trip legs run the installer and the
// pool scanner — the exact path a user install takes.
const suiteSpec: ReleaseSpec = {
  name: '@snap-rail/suite-terminal-ops',
  dir: join(import.meta.dirname, '../../../suites/terminal-ops'),
  hostDir: 'lib',
  hostFace: 'lib/stats.js',
  clientFace: 'lib-client',
}

const driverSpec: ReleaseSpec = {
  name: '@snap-rail/driver-mock',
  dir: join(import.meta.dirname, '../../../field/driver-mock'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
}

const forgeSpec: ReleaseSpec = {
  name: '@snap-rail/forge',
  dir: join(import.meta.dirname, '../../../tools/forge'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  clientFace: 'lib-client',
}

const modbusSpec: ReleaseSpec = {
  name: '@snap-rail/driver-modbus',
  dir: join(import.meta.dirname, '../../../field/driver-modbus'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
}

describe('release manifest derivation', () => {
  it('trims to npm identity + host face and carries snapRail verbatim', () => {
    const source = {
      name: '@scope/p',
      version: '1.0.0',
      description: 'demo',
      snapRail: { kind: 'driver', client: { entry: 'lib/client.js' } },
      // Workspace plumbing the zip never carries.
      scripts: { build: 'tsdown' },
      devDependencies: { react: '*' },
    }
    const manifest = JSON.parse(releaseManifest(source, 'lib/index.js'))
    expect(manifest).toEqual({
      name: '@scope/p',
      version: '1.0.0',
      description: 'demo',
      type: 'module',
      main: 'lib/index.js',
      snapRail: { kind: 'driver', client: { entry: 'lib/client.js' } },
    })
  })

  it('fails loud when the spec and the manifest disagree on the name', async () => {
    await expect(releaseFiles({ ...driverSpec, name: '@snap-rail/other' })).rejects.toThrow(/does not match/)
  })
})

describe('final-format assembly (built tree)', () => {
  it('suite zip: manifest + host face + client bundle + assets, no sources', async () => {
    const files = await releaseFiles(suiteSpec)
    const paths = Object.keys(files).sort()
    expect(paths).toContain('package.json')
    expect(paths).toContain('lib/stats.js')
    expect(paths).toContain('lib-client/client.js')
    expect(paths.some(path => path.startsWith('lib-client/assets/'))).toBe(true)
    // Multi-entry host builds emit shared chunks beside the entries — the
    // whole built directory ships, declarations, maps, and the tsc staging
    // tree never.
    expect(paths.filter(path => path.startsWith('lib/') && path.endsWith('.js')).length).toBeGreaterThan(1)
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('lib/types/'))).toBe(true)
    expect(paths.every(path => !path.endsWith('.d.ts') && !path.endsWith('.js.map'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.name).toBe('@snap-rail/suite-terminal-ops')
    expect(manifest.main).toBe('lib/stats.js')
    expect(manifest.snapRail).toEqual({ kind: 'suite', client: { entry: 'lib-client/client.js' } })
  })

  it('driver zip: host-only, no client face', async () => {
    const files = await releaseFiles(driverSpec)
    const paths = Object.keys(files)
    expect(paths).toContain('lib/index.js')
    expect(paths).toContain('package.json')
    expect(paths.every(path => path === 'package.json' || path.startsWith('lib/'))).toBe(true)
  })
})

describe('pool-anchor discipline (shipped host faces)', () => {
  /** The root package id of a bare specifier (`@scope/name` keeps two segments). */
  const rootOf = (id: string): string =>
    id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]!

  /** Every static bare import/require target in a built face (relatives and
   * node builtins excluded — the anchor list never sees them). */
  const bareIds = (source: string): Set<string> => {
    const ids = new Set<string>()
    for (const pattern of [/from\s*"([^".][^"]*)"/g, /require\(\s*"([^".][^"]*)"\s*\)/g]) {
      for (const match of source.matchAll(pattern)) {
        const id = match[1]!
        if (!id.startsWith('node:')) ids.add(rootOf(id))
      }
    }
    return ids
  }

  it('bare-imports only ids the desktop app carries as dependencies', async () => {
    const desktop = JSON.parse(readFileSync(
      join(import.meta.dirname, '../../../../apps/desktop/package.json'),
      'utf8',
    )) as { dependencies: Record<string, string> }
    const carried = new Set(Object.keys(desktop.dependencies))
    for (const spec of [suiteSpec, driverSpec, modbusSpec, forgeSpec]) {
      const source = readFileSync(join(spec.dir, spec.hostFace), 'utf8')
      const ids = [...bareIds(source)].filter(id => id.startsWith('@snap-rail/') || id === 'zod' || id === 'drizzle-orm')
      const missing = ids.filter(id => !carried.has(id))
      // resolve-hooks anchors pool bare imports to the app root; an id the
      // app does not carry dies at boot exactly there.
      expect(missing, `${spec.name} host face anchors uncarried ids`).toEqual([])
    }
  })
})

describe('install round-trip', () => {
  it('a packed zip installs and scans back as the declared package', async () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-pack-'))
    try {
      const pool = join(base, 'plugins')
      for (const spec of [suiteSpec, driverSpec]) {
        const zip = join(base, zipFileName(spec.name))
        writeFileSync(zip, zipSync(await releaseFiles(spec)))
        const installed = installPluginFromZip(zip, pool)
        expect(installed.name).toBe(spec.name)
      }
      const scanned = scanPluginPool([pool])
      const suite = scanned.get('@snap-rail/suite-terminal-ops')
      expect(suite?.kind).toBe('suite')
      expect(suite?.clientEntry).toBe('lib-client/client.js')
      // The pool mounts exactly one host entry per package: the manifest main.
      expect(suite?.entryUrl.endsWith('/lib/stats.js')).toBe(true)
      const driver = scanned.get('@snap-rail/driver-mock')
      expect(driver?.kind).toBe('driver')
      expect(driver?.clientEntry).toBeUndefined()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
