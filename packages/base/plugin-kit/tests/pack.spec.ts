import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { installPluginFromZip } from '../../../base/app-boot/src/installer.ts'
import { scanPluginPool } from '@snap-rail/app-boot/scan'
import { releaseFiles, releaseManifest, zipFileName, type ReleaseSpec } from '../src/pack.ts'

// The specs mirror scripts/pack-plugins.ts against the built workspace tree
// (pnpm test builds first); the round-trip legs run the installer and the
// pool scanner — the exact path a user install takes.
const suiteSpec: ReleaseSpec = {
  name: '@snap-rail/suite-terminal-ops',
  dir: join(import.meta.dirname, '../../../suite/terminal-ops'),
  clientFace: 'lib-client',
}

const frameworkSpec: ReleaseSpec = {
  name: '@snap-rail/framework-shadcn',
  dir: join(import.meta.dirname, '../../../ui/framework-shadcn'),
  clientFace: 'lib-client',
}

const modbusSpec: ReleaseSpec = {
  name: '@snap-rail/driver-modbus',
  dir: join(import.meta.dirname, '../../../equipment/driver-modbus'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  exports: { './contract': 'lib/contract.js' },
}

const equipmentSpec: ReleaseSpec = {
  name: '@snap-rail/equipment',
  dir: join(import.meta.dirname, '../../../equipment/equipment'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  exports: { './rpc': 'lib/rpc.js', './contract': 'lib/contract.js' },
}

const trendSpec: ReleaseSpec = {
  name: '@snap-rail/trend',
  dir: join(import.meta.dirname, '../../../tool/trend'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  exports: { './contract': 'lib/contract.js' },
}

const forgeSpec: ReleaseSpec = {
  name: '@snap-rail/forge',
  dir: join(import.meta.dirname, '../../../tool/forge'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  clientFace: 'lib-client',
  exports: { './contract': 'lib/contract.js' },
}

const HOSTED_SPECS = [modbusSpec, equipmentSpec, trendSpec, forgeSpec] as const

describe('release manifest derivation', () => {
  it('trims to npm identity + main + the exports voice and carries snapRail verbatim', () => {
    const source = {
      name: '@scope/p',
      version: '1.0.0',
      description: 'demo',
      snapRail: { kind: 'driver', client: { entry: 'lib/client.js' } },
      // Workspace plumbing the zip never carries.
      scripts: { build: 'tsdown' },
      devDependencies: { react: '*' },
    }
    const manifest = JSON.parse(releaseManifest(source, 'lib/index.js', { './contract': 'lib/contract.js' }))
    expect(manifest).toEqual({
      name: '@scope/p',
      version: '1.0.0',
      description: 'demo',
      type: 'module',
      main: 'lib/index.js',
      exports: { '.': 'lib/index.js', './contract': 'lib/contract.js' },
      snapRail: { kind: 'driver', client: { entry: 'lib/client.js' } },
    })
  })

  it('fails loud when the spec and the manifest disagree on the name', async () => {
    await expect(releaseFiles({ ...modbusSpec, name: '@snap-rail/other' })).rejects.toThrow(/does not match/)
  })

  it('fails loud when a host-face spec omits the hostDir or the host face itself', async () => {
    await expect(releaseFiles({ ...modbusSpec, hostDir: undefined })).rejects.toThrow(/host face without a hostDir/)
    await expect(releaseFiles({ ...modbusSpec, hostFace: undefined })).rejects.toThrow(/snapRail.clientOnly/)
  })
})

describe('final-format assembly (built tree)', () => {
  it('clientOnly zip: manifest + client bundle + assets, no host face, no sources', async () => {
    const files = await releaseFiles(suiteSpec)
    const paths = Object.keys(files).sort()
    expect(paths).toContain('package.json')
    expect(paths).toContain('lib-client/client.js')
    expect(paths.every(path => path === 'package.json' || path.startsWith('lib-client/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    expect(paths.every(path => !path.endsWith('.d.ts') && !path.endsWith('.js.map'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.name).toBe('@snap-rail/suite-terminal-ops')
    // clientOnly: main names the client bundle; the exports voice carries it.
    expect(manifest.main).toBe('lib-client/client.js')
    expect(manifest.exports).toEqual({ '.': 'lib-client/client.js' })
    expect(manifest.snapRail.clientOnly).toBe(true)
    expect(manifest.snapRail.category).toBe('界面')
    expect(manifest.snapRail.title).toBe('生产作业套件')
    expect(manifest.snapRail.client).toEqual({ entry: 'lib-client/client.js' })
  })

  it('framework zip carries the precompiled tailwind output beside the bundle', async () => {
    const files = await releaseFiles(frameworkSpec)
    const paths = Object.keys(files)
    expect(paths).toContain('lib-client/client.js')
    expect(paths).toContain('lib-client/theme.css')
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.snapRail.client.seeds).toContain('ui')
    expect(manifest.snapRail.client.seeds).toContain('runtime')
  })

  it('host zip: manifest + host face + the exports targets, no sources', async () => {
    const files = await releaseFiles(equipmentSpec)
    const paths = Object.keys(files)
    expect(paths).toContain('lib/index.js')
    expect(paths).toContain('lib/rpc.js')
    expect(paths).toContain('lib/contract.js')
    expect(paths).toContain('package.json')
    // Multi-entry host builds emit shared chunks beside the entries — the
    // whole built directory ships, declarations, maps, and the tsc staging
    // tree never.
    expect(paths.filter(path => path.startsWith('lib/') && path.endsWith('.js')).length).toBeGreaterThan(2)
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('lib/types/'))).toBe(true)
    expect(paths.every(path => !path.endsWith('.d.ts') && !path.endsWith('.js.map'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.exports).toEqual({
      '.': 'lib/index.js',
      './rpc': 'lib/rpc.js',
      './contract': 'lib/contract.js',
    })
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

  it('bare-imports only ids the desktop app carries or the pool provides', async () => {
    const desktop = JSON.parse(readFileSync(
      join(import.meta.dirname, '../../../../apps/desktop/package.json'),
      'utf8',
    )) as { dependencies: Record<string, string> }
    // The resolution order: appRoot first (the app's own dependency tree —
    // specs like @snap-rail/store and the shared libraries), pool fallback
    // (installed-only packages like equipment). An id in neither universe
    // dies at boot exactly there.
    const carried = new Set<string>([...Object.keys(desktop.dependencies), ...HOSTED_SPECS.map(spec => spec.name)])
    for (const spec of HOSTED_SPECS) {
      const source = readFileSync(join(spec.dir, spec.hostFace!), 'utf8')
      const ids = [...bareIds(source)].filter(id => id.startsWith('@snap-rail/') || id === 'zod' || id === 'drizzle-orm')
      const missing = ids.filter(id => !carried.has(id))
      expect(missing, `${spec.name} host face anchors uncarried ids`).toEqual([])
    }
  })
})

describe('install round-trip', () => {
  it('packed zips install and scan back with their manifest markers', async () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-pack-'))
    try {
      const pool = join(base, 'plugins')
      for (const spec of [suiteSpec, modbusSpec]) {
        const zip = join(base, zipFileName(spec.name))
        writeFileSync(zip, zipSync(await releaseFiles(spec)))
        const installed = installPluginFromZip(zip, pool)
        expect(installed.name).toBe(spec.name)
      }
      const scanned = scanPluginPool([pool])
      const suite = scanned.get('@snap-rail/suite-terminal-ops')
      expect(suite?.kind).toBe('suite')
      expect(suite?.clientOnly).toBe(true)
      expect(suite?.category).toBe('界面')
      expect(suite?.title).toBe('生产作业套件')
      expect(suite?.clientEntry).toBe('lib-client/client.js')
      // The pool mounts exactly one host entry per package: the manifest main.
      expect(suite?.entryUrl.endsWith('/lib-client/client.js')).toBe(true)
      const driver = scanned.get('@snap-rail/driver-modbus')
      expect(driver?.kind).toBe('driver')
      expect(driver?.clientEntry).toBeUndefined()
      expect(driver?.category).toBe('设备')
      expect(driver?.title).toBe('ModbusTCP 驱动')
      expect(driver?.requires).toEqual(['@snap-rail/equipment'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
