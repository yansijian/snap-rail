import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clientBundle, hostBundle, CLIENT_EXTERNALS, CONTRIBUTED_SEED_MODULES, SEED_MODULES, snapRailManifestSchema } from '../src/index.ts'

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

  it('rejects unknown kinds and unknown fields', () => {
    expect(snapRailManifestSchema.safeParse({ kind: 'widget' }).success).toBe(false)
    expect(snapRailManifestSchema.safeParse({ kind: 'driver', extra: 1 }).success).toBe(false)
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
