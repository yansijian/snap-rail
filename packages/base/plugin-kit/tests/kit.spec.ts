import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { rolldown } from 'rolldown'
import {
  clientBundle,
  hostBundle,
  CLIENT_EXTERNALS,
  CONTRIBUTED_SEED_MODULES,
  releaseFiles,
  releaseManifest,
  SEED_ABI_REVISION,
  seedImportGuard,
  SEED_MODULES,
  checkSeedAbi,
  snapRailManifestSchema,
} from '../src/index.ts'

describe('snapRail manifest schema', () => {
  it('accepts the full vocabulary and applies the client-entry default', () => {
    const parsed = snapRailManifestSchema.parse({
      kind: 'suite',
      client: {},
      permissions: ['field:write'],
    })
    expect(parsed.kind).toBe('suite')
    expect(parsed.client?.entry).toBe('lib/client.js')
    expect(parsed.permissions).toEqual(['field:write'])
  })

  it('rejects unknown kinds; strips retired fields (legacy-zip tolerance)', () => {
    expect(snapRailManifestSchema.safeParse({ kind: 'widget' }).success).toBe(false)
    // The snapRail level is deliberately not strict: retired vocabulary in
    // already-published zips (framework/capabilities) strips off instead of
    // failing the install.
    const stripped = snapRailManifestSchema.parse({ kind: 'driver', extra: 1, framework: '@scope/x' })
    expect(stripped).toEqual({ kind: 'driver' })
    expect(snapRailManifestSchema.safeParse({ client: { entry: '' } }).success).toBe(false)
  })

  it('round-trips the empty manifest (everything optional)', () => {
    expect(snapRailManifestSchema.parse({})).toEqual({})
  })
})

describe('tsdown presets', () => {
  it('host face: ESM node bundle', () => {
    const config = hostBundle('src/host.ts')
    expect(config.format).toEqual(['esm'])
    expect(config.platform).toBe('node')
  })
})

describe('seed tiers', () => {
  it('base tier: shared spine + react + the wire contracts, nothing else', () => {
    expect(SEED_MODULES).toContain('react')
    expect(SEED_MODULES).toContain('zod')
    // Spine faces the renderer consumes at runtime: contract subpaths, the
    // timer primitives, and the pure utilities.
    expect(SEED_MODULES).toContain('@snap-rail/equipment/contract')
    expect(SEED_MODULES).toContain('@snap-rail/util')
    expect(SEED_MODULES).toContain('@snap-rail/cordis-plugin-timer')
    // No plugin packages: cross-plugin value imports are forbidden — a
    // scenario's contract lives inside its suite package.
    expect(SEED_MODULES.filter(id => id.includes('suite-') || id.includes('driver-') || id.includes('trend'))).toEqual([])
    // No host entries: the node side must never enter the client graph.
    expect(SEED_MODULES.filter(id => id === '@snap-rail/equipment' || id === '@snap-rail/store')).toEqual([])
    // The framework's faces are NOT base — they arrive with the installed
    // framework's client face.
    expect(SEED_MODULES.filter(id => id.startsWith('@snap-rail/framework-shadcn'))).toEqual([])
  })

  it('contributed tier: the framework faces only; the union is the external surface', () => {
    expect(CONTRIBUTED_SEED_MODULES).toContain('@snap-rail/framework-shadcn/ui')
    expect(CONTRIBUTED_SEED_MODULES).toContain('@snap-rail/framework-shadcn/runtime')
    expect(CONTRIBUTED_SEED_MODULES.every(id => id.startsWith('@snap-rail/framework-shadcn/'))).toBe(true)
    expect([...CLIENT_EXTERNALS].sort()).toEqual([...new Set([...SEED_MODULES, ...CONTRIBUTED_SEED_MODULES])].sort())
  })

  it('client face: CJS browser bundle, union external, wrapper welded', () => {
    const packageName = '@scope/my-suite'
    const config = clientBundle(packageName, 'src/client.tsx')
    expect(config.format).toEqual(['cjs'])
    expect(config.platform).toBe('browser')
    expect(config.external).toEqual([...CLIENT_EXTERNALS])
    const options = typeof config.outputOptions === 'function' ? undefined : config.outputOptions
    const banner = options && 'banner' in options ? String(options.banner) : ''
    const footer = options && 'footer' in options ? String(options.footer) : ''
    expect(banner).toContain(`window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory:`)
    expect(footer).toContain('module.exports.default : module.exports; } });')
  })

  it('client face: manifest-declared externalSeeds join the external surface', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-externals-'))
    const previous = process.cwd()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@t/consumer',
        snapRail: { client: { entry: 'lib/client.js', externalSeeds: ['@acme/framework-x/ui', '@b/ext/datepicker'] } },
      }))
      process.chdir(dir)
      const config = clientBundle('@t/consumer', 'src/index.tsx')
      const external = (config as { external?: readonly string[] }).external ?? []
      expect(external).toEqual([...CLIENT_EXTERNALS, '@acme/framework-x/ui', '@b/ext/datepicker'])
    } finally {
      process.chdir(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest schema accepts declared externalSeeds', () => {
    const parsed = snapRailManifestSchema.parse({ client: { externalSeeds: ['@acme/framework-x/ui'] } })
    expect(parsed.client?.externalSeeds).toEqual(['@acme/framework-x/ui'])
    expect(snapRailManifestSchema.safeParse({ client: { externalSeeds: [''] } }).success).toBe(false)
  })
})

describe('zod interop sanity', () => {
  it('schema composes with the field base manifest', () => {
    const extended = snapRailManifestSchema.extend({ minHost: z.string() })
    expect(extended.parse({ kind: 'driver', minHost: '0.2.0' })).toMatchObject({ kind: 'driver' })
  })
})

describe('seed ABI', () => {
  const host = { revision: SEED_ABI_REVISION, versions: { 'zod': '4.4.3', '@snap-rail/cordis': '4.0.1' } }

  it('the same revision and same majors pass', () => {
    const verdict = checkSeedAbi({ revision: SEED_ABI_REVISION, versions: { 'zod': '4.4.1', '@snap-rail/cordis': '4.9.0' } }, host)
    expect(verdict).toMatchObject({ ok: true, undeclared: false })
  })

  it('a foreign revision refuses', () => {
    const verdict = checkSeedAbi({ revision: SEED_ABI_REVISION + 1, versions: {} }, host)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain(`r${SEED_ABI_REVISION + 1}`)
  })

  it('a major drift refuses; patch/minor drift passes', () => {
    const drifted = checkSeedAbi({ revision: SEED_ABI_REVISION, versions: { 'zod': '5.0.0' } }, host)
    expect(drifted.ok).toBe(false)
    expect(drifted.reason).toContain('zod@5.0.0')
    expect(checkSeedAbi({ revision: SEED_ABI_REVISION, versions: { 'zod': '4.5.0' } }, host).ok).toBe(true)
  })

  it('an absent declaration passes as the grace window', () => {
    expect(checkSeedAbi(undefined, host)).toMatchObject({ ok: true, undeclared: true })
  })

  it('only the declared∩host intersection is compared; garbage versions never pass', () => {
    expect(checkSeedAbi({ revision: SEED_ABI_REVISION, versions: { '@snap-rail/unknown-face': '9.9.9' } }, host).ok).toBe(true)
    expect(checkSeedAbi({ revision: SEED_ABI_REVISION, versions: { 'zod': 'not-a-version' } }, host).ok).toBe(false)
  })

  it('the manifest schema accepts the stamped shape', () => {
    expect(snapRailManifestSchema.parse({ client: { seedAbi: { revision: 1, versions: { 'zod': '4.4.3' } } } }).client?.seedAbi).toEqual({ revision: 1, versions: { 'zod': '4.4.3' } })
  })
})

describe('seed import guard', () => {
  async function buildFace(source: string, moduleId = 'virtual-entry.ts'): Promise<void> {
    const bundle = await rolldown({
      input: { client: moduleId },
      external: [...CLIENT_EXTERNALS],
      plugins: [
        {
          name: 'virtual-entry',
          resolveId(id) { return id === moduleId ? id : null },
          load(id) { return id === moduleId ? source : null },
        },
        seedImportGuard(),
      ],
    })
    await bundle.generate({ format: 'cjs' })
  }

  it('a default import of a seed id fails the build with the fix guidance', async () => {
    await expect(buildFace("import timerPlugin from '@snap-rail/cordis-plugin-timer'\nexport const v = timerPlugin\n"))
      .rejects.toThrow(/默认导入/)
  })

  it('named, star, and type-only imports pass; inlined dependencies keep their style', async () => {
    await expect(buildFace("import { TimerService } from '@snap-rail/cordis-plugin-timer'\nimport * as zodNs from 'zod'\nimport type { Plugin } from '@snap-rail/cordis'\nexport const v = TimerService && zodNs && 1\n"))
      .resolves.toBeUndefined()
    await expect(buildFace("import react from 'react'\nexport const v = typeof react\n", '/tmp/project/node_modules/dep/index.js'))
      .resolves.toBeUndefined()
  })
})

describe('pack-time seed ABI stamping', () => {
  it('the release manifest carries the stamp and the release files ship it', async () => {
    const stamped = JSON.parse(releaseManifest(
      { name: '@t/face', snapRail: { client: { entry: 'lib-client/client.js' } } },
      'lib-client/client.js',
      undefined,
      { revision: SEED_ABI_REVISION, versions: { 'zod': '4.4.3' } },
    )) as { snapRail?: { client?: { seedAbi?: unknown } } }
    expect(stamped.snapRail?.client?.seedAbi).toEqual({ revision: SEED_ABI_REVISION, versions: { 'zod': '4.4.3' } })

    const dir = mkdtempSync(join(tmpdir(), 'kit-stamp-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@t/face',
        version: '1.0.0',
        snapRail: { clientOnly: true, client: { entry: 'lib-client/client.js' } },
      }))
      mkdirSync(join(dir, 'lib-client'), { recursive: true })
      writeFileSync(join(dir, 'lib-client', 'client.js'), 'module.exports = require("zod"); require("@snap-rail/cordis-plugin-timer");')
      // Both required seeds resolve inside the fixture tree (hermetic — no
      // ambient walk-up): the stamp carries exactly their stub versions.
      for (const [name, version] of [['zod', '4.4.3'], ['@snap-rail/cordis-plugin-timer', '9.9.9']] as const) {
        mkdirSync(join(dir, 'node_modules', ...name.split('/')), { recursive: true })
        writeFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ name, version }))
      }
      const files = await releaseFiles({
        name: '@t/face',
        dir,
        clientFace: 'lib-client',
      })
      const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as {
        snapRail?: { client?: { seedAbi?: { revision: number, versions: Record<string, string> } } }
      }
      expect(manifest.snapRail?.client?.seedAbi).toEqual({
        revision: SEED_ABI_REVISION,
        versions: { 'zod': '4.4.3', '@snap-rail/cordis-plugin-timer': '9.9.9' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
