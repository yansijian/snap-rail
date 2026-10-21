import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginFromZip } from '../../../base/app-boot/src/installer.ts'
import { scanPluginPool } from '@snap-rail/app-boot/scan'
import { releaseFiles, releaseManifest, zipFileName, type ReleaseSpec } from '../src/pack.ts'

/**
 * Fixture packages stand in for the standalone plugin repositories (the
 * framework, the drivers, and the suites moved out — see
 * docs/split-runbook.md): the assembly rules under test live in
 * `@snap-rail/plugin-kit/pack`, so a tmpdir package with a manifest and
 * built faces exercises them exactly, and the real equipment package rides
 * along as the one in-repo host face. The round-trip legs run the installer
 * and the pool scanner — the exact path a user install takes.
 */

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Materialize a fixture package directory and return its spec. Fixture
 * dirs live for the whole file run (module-load time creation); only
 * per-test scratch lands in `scratch`. */
function fixturePackage(name: string, manifest: Record<string, unknown>, files: Record<string, string>): ReleaseSpec {
  const dir = mkdtempSync(join(tmpdir(), `snap-rail-pack-${name.replaceAll(/[^a-z-]/g, '')}-`))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return { name, dir }
}

const HOST_FIXTURE_MANIFEST = {
  version: '1.0.0',
  description: 'fixture driver',
  main: 'lib/index.js',
  type: 'module',
  snapRail: {
    kind: 'driver',
    category: '设备',
    title: '夹具驱动',
    requires: ['@snap-rail/equipment'],
  },
}

const hostFixtureSpec = fixturePackage('@fixture/host', HOST_FIXTURE_MANIFEST, {
  'lib/index.js': 'import { z } from "zod"\nexport default { name: "@fixture/host", apply() {} }\n',
  'lib/contract.js': 'export const dialect = "fixture"\n',
  'lib/chunk.js': 'export const shared = 1\n',
  'lib/types/index.d.ts': 'export {}\n',
  'lib/types/index.js.map': '{}\n',
  'src/index.ts': 'export {}\n',
})

const hostFixtureSpecWithExports: ReleaseSpec = {
  ...hostFixtureSpec,
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  exports: { './contract': 'lib/contract.js' },
}

const clientOnlyFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/frame', {
    version: '2.0.0',
    description: 'fixture framework',
    type: 'module',
    snapRail: {
      kind: 'framework',
      category: '界面',
      clientOnly: true,
      client: { entry: 'lib-client/client.js', seeds: ['ui', 'runtime'] },
    },
  }, {
    'lib-client/client.js': 'module.exports = { seeds: { ui: {}, runtime: {} } }\n',
    'lib-client/theme.css': '.fixture {}\n',
    'lib/index.js': 'export const framework = "@fixture/frame"\n',
    'src/client.ts': 'export {}\n',
  }),
  clientFace: 'lib-client',
}

const dualFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/suite', {
    version: '3.0.0',
    description: 'fixture suite',
    main: 'lib/stats.js',
    type: 'module',
    snapRail: {
      kind: 'suite',
      category: '界面',
      title: '夹具套件',
      requires: ['@fixture/frame', '@snap-rail/equipment', 'service:store'],
      client: { entry: 'lib-client/client.js' },
    },
  }, {
    'lib/stats.js': 'export const counter = 1\n',
    'lib-client/client.js': 'module.exports = { name: "@fixture/suite", apply() {} }\n',
  }),
  hostDir: 'lib',
  hostFace: 'lib/stats.js',
  clientFace: 'lib-client',
}

const equipmentSpec: ReleaseSpec = {
  name: '@snap-rail/equipment',
  dir: join(import.meta.dirname, '../../../equipment/equipment'),
  hostDir: 'lib',
  hostFace: 'lib/index.js',
  exports: { './rpc': 'lib/rpc.js', './contract': 'lib/contract.js' },
}

/** A dual-face package shipping a main bundle plus a face per auxiliary
 * surface — the multi-window shape (B1: one package, several client entries). */
const multiSurfaceFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/multi', {
    version: '1.1.0',
    description: 'fixture multi-surface suite',
    main: 'lib/stats.js',
    type: 'module',
    snapRail: {
      kind: 'suite',
      title: '夹具多面套件',
      client: {
        entry: 'lib-client/client.js',
        surfaces: { ball: 'lib-client/ball.js', panel: 'lib-client/panel.js' },
      },
    },
  }, {
    'lib/stats.js': 'export const counter = 1\n',
    'lib-client/client.js': 'module.exports = { name: "@fixture/multi", apply() {} }\n',
    'lib-client/ball.js': 'module.exports = { name: "@fixture/multi/ball", apply() {} }\n',
    'lib-client/panel.js': 'module.exports = { name: "@fixture/multi/panel", apply() {} }\n',
  }),
  hostDir: 'lib',
  hostFace: 'lib/stats.js',
  clientFace: 'lib-client',
}

/** A renderer-only package whose declared ball face never got built. */
const missingSurfaceFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/missing-ball', {
    version: '1.0.0',
    description: 'fixture with an unbuilt ball face',
    type: 'module',
    snapRail: {
      kind: 'framework',
      clientOnly: true,
      client: { entry: 'lib-client/client.js', surfaces: { ball: 'lib-client/ball.js' } },
    },
  }, {
    'lib-client/client.js': 'module.exports = { seeds: { ui: {} } }\n',
  }),
  clientFace: 'lib-client',
}

/** A package pointing a surface at the main bundle — no window would own it. */
const aliasedSurfaceFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/aliased-ball', {
    version: '1.0.0',
    description: 'fixture with an aliased ball face',
    type: 'module',
    snapRail: {
      kind: 'framework',
      clientOnly: true,
      client: { entry: 'lib-client/client.js', surfaces: { ball: 'lib-client/client.js' } },
    },
  }, {
    'lib-client/client.js': 'module.exports = { seeds: { ui: {} } }\n',
  }),
  clientFace: 'lib-client',
}

/** A package claiming the main surface as an auxiliary one. */
const mainSurfaceFixtureSpec: ReleaseSpec = {
  ...fixturePackage('@fixture/main-surface', {
    version: '1.0.0',
    description: 'fixture claiming a main surface entry',
    type: 'module',
    snapRail: {
      kind: 'framework',
      clientOnly: true,
      client: { entry: 'lib-client/client.js', surfaces: { main: 'lib-client/main.js' } },
    },
  }, {
    'lib-client/client.js': 'module.exports = { seeds: { ui: {} } }\n',
    'lib-client/main.js': 'module.exports = { name: "@fixture/main-surface/main" }\n',
  }),
  clientFace: 'lib-client',
}

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
    await expect(releaseFiles({ ...hostFixtureSpecWithExports, name: '@snap-rail/other' })).rejects.toThrow(/does not match/)
  })

  it('fails loud when a host-face spec omits the hostDir or the host face itself', async () => {
    await expect(releaseFiles({ ...hostFixtureSpecWithExports, hostDir: undefined })).rejects.toThrow(/host face without a hostDir/)
    await expect(releaseFiles({ ...hostFixtureSpecWithExports, hostFace: undefined })).rejects.toThrow(/snapRail.clientOnly/)
  })

  it('fails loud when an exports target does not ship', async () => {
    await expect(releaseFiles({
      ...hostFixtureSpecWithExports,
      exports: { './contract': 'lib/missing.js' },
    })).rejects.toThrow(/does not carry it/)
  })
})

describe('final-format assembly (built tree)', () => {
  it('clientOnly zip: manifest + client bundle + assets, no host face, no sources', async () => {
    const files = await releaseFiles(clientOnlyFixtureSpec)
    const paths = Object.keys(files).sort()
    expect(paths).toContain('package.json')
    expect(paths).toContain('lib-client/client.js')
    expect(paths).toContain('lib-client/theme.css')
    expect(paths.every(path => path === 'package.json' || path.startsWith('lib-client/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('lib/'))).toBe(true)
    expect(paths.every(path => !path.endsWith('.d.ts') && !path.endsWith('.js.map'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    // clientOnly: main names the client bundle; the exports voice carries it.
    expect(manifest.main).toBe('lib-client/client.js')
    expect(manifest.exports).toEqual({ '.': 'lib-client/client.js' })
    expect(manifest.snapRail.clientOnly).toBe(true)
    expect(manifest.snapRail.category).toBe('界面')
    expect(manifest.snapRail.client?.entry).toBe('lib-client/client.js')
  })

  it('dual-face zip: host face + client bundle, sources never', async () => {
    const files = await releaseFiles(dualFixtureSpec)
    const paths = Object.keys(files).sort()
    expect(paths).toContain('lib/stats.js')
    expect(paths).toContain('lib-client/client.js')
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    expect(paths.every(path => !path.startsWith('lib/types/'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    // Dual-face: npm main names the host face; the client face rides snapRail.
    expect(manifest.main).toBe('lib/stats.js')
    expect(manifest.snapRail.clientOnly).toBeUndefined()
    expect(manifest.snapRail.client).toEqual({ entry: 'lib-client/client.js' })
  })

  it('host zip: manifest + host face + the exports targets, no sources', async () => {
    const files = await releaseFiles(hostFixtureSpecWithExports)
    const paths = Object.keys(files)
    expect(paths).toContain('lib/index.js')
    expect(paths).toContain('lib/contract.js')
    // Multi-entry host builds emit shared chunks beside the entries — the
    // whole built directory ships, declarations, maps, and the tsc staging
    // tree never.
    expect(paths).toContain('lib/chunk.js')
    expect(paths).not.toContain('lib/types/index.d.ts')
    expect(paths).not.toContain('lib/types/index.js.map')
    expect(paths.every(path => !path.startsWith('src/'))).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.exports).toEqual({
      '.': 'lib/index.js',
      './contract': 'lib/contract.js',
    })
  })

  it('the in-repo equipment package assembles with its rpc + contract subpaths', async () => {
    const files = await releaseFiles(equipmentSpec)
    const paths = Object.keys(files)
    expect(paths).toContain('lib/index.js')
    expect(paths).toContain('lib/rpc.js')
    expect(paths).toContain('lib/contract.js')
    expect(paths).toContain('package.json')
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    expect(manifest.exports).toEqual({
      '.': 'lib/index.js',
      './rpc': 'lib/rpc.js',
      './contract': 'lib/contract.js',
    })
  })

  it('multi-surface zip: one client bundle per window, the surfaces map preserved', async () => {
    const files = await releaseFiles(multiSurfaceFixtureSpec)
    const paths = Object.keys(files)
    expect(paths).toContain('lib-client/client.js')
    expect(paths).toContain('lib-client/ball.js')
    expect(paths).toContain('lib-client/panel.js')
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!))
    // The host face stays `main`; the client face keeps every surface entry
    // so the host can hand the renderer one loader URL per window.
    expect(manifest.main).toBe('lib/stats.js')
    expect(manifest.snapRail.client).toEqual({
      entry: 'lib-client/client.js',
      surfaces: { ball: 'lib-client/ball.js', panel: 'lib-client/panel.js' },
    })
  })

  it('fails loud when a declared surface entry does not ship', async () => {
    await expect(releaseFiles(missingSurfaceFixtureSpec)).rejects.toThrow(/ball surface entry lib-client\/ball\.js/)
  })

  it('fails loud when a surface aliases the main bundle or claims `main`', async () => {
    await expect(releaseFiles(aliasedSurfaceFixtureSpec)).rejects.toThrow(/needs its own bundle/)
    await expect(releaseFiles(mainSurfaceFixtureSpec)).rejects.toThrow(/invalid snapRail\.client\.surfaces/)
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
    const carried = new Set<string>([...Object.keys(desktop.dependencies), equipmentSpec.name])
    const source = readFileSync(join(equipmentSpec.dir, equipmentSpec.hostFace!), 'utf8')
    const ids = [...bareIds(source)].filter(id => id.startsWith('@snap-rail/') || id === 'zod' || id === 'drizzle-orm')
    const missing = ids.filter(id => !carried.has(id))
    expect(missing, `${equipmentSpec.name} host face anchors uncarried ids`).toEqual([])
  })
})

describe('install round-trip', () => {
  it('packed zips install and scan back with their manifest markers', async () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-pack-'))
    scratch.push(base)
    const pool = join(base, 'plugins')
    for (const spec of [dualFixtureSpec, multiSurfaceFixtureSpec, hostFixtureSpecWithExports]) {
      const zip = join(base, zipFileName(spec.name))
      writeFileSync(zip, zipSync(await releaseFiles(spec)))
      const installed = installPluginFromZip(zip, pool)
      expect(installed.name).toBe(spec.name)
    }
    const scanned = scanPluginPool([pool])
    const suite = scanned.get('@fixture/suite')
    expect(suite?.kind).toBe('suite')
    expect(suite?.clientOnly).toBeUndefined()
    expect(suite?.category).toBe('界面')
    expect(suite?.title).toBe('夹具套件')
    expect(suite?.clientEntry).toBe('lib-client/client.js')
    expect(suite?.requires).toEqual(['@fixture/frame', '@snap-rail/equipment', 'service:store'])
    // The pool mounts exactly one host entry per package: the manifest main.
    expect(suite?.entryUrl.endsWith('/lib/stats.js')).toBe(true)
    const driver = scanned.get('@fixture/host')
    expect(driver?.kind).toBe('driver')
    expect(driver?.clientEntry).toBeUndefined()
    expect(driver?.category).toBe('设备')
    expect(driver?.title).toBe('夹具驱动')
    expect(driver?.requires).toEqual(['@snap-rail/equipment'])
    // The multi-window face survives the round trip: the scan reports one
    // entry per auxiliary surface, which is what the host resolves to loader
    // URLs before the renderer asks for its rows.
    const multi = scanned.get('@fixture/multi')
    expect(multi?.clientEntry).toBe('lib-client/client.js')
    expect(multi?.clientSurfaces).toEqual({ ball: 'lib-client/ball.js', panel: 'lib-client/panel.js' })
    expect(suite?.clientSurfaces).toBeUndefined()
  })
})
