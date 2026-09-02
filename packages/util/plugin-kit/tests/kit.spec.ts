import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clientBundle, hostBundle, SEED_MODULES, snapRailManifestSchema } from '../src/index.ts'

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

describe('seed whitelist', () => {
  it('carries the shared spine + react and nothing else', () => {
    expect(SEED_MODULES).toContain('react')
    expect(SEED_MODULES).toContain('zod')
    expect(SEED_MODULES).toContain('@snap-rail/client-ui')
    // Spine faces the renderer consumes at runtime: contract subpaths, the
    // timer primitives, and the pure utilities.
    expect(SEED_MODULES).toContain('@snap-rail/field/contract')
    expect(SEED_MODULES).toContain('@snap-rail/util')
    expect(SEED_MODULES).toContain('@snap-rail/cordis-plugin-timer')
    // No plugin packages: cross-plugin value imports are forbidden.
    expect(SEED_MODULES.filter(id => id.includes('suite-') || id.includes('driver-'))).toEqual([])
    // No host entries: the node side must never enter the client graph.
    expect(SEED_MODULES.filter(id => id === '@snap-rail/field' || id === '@snap-rail/store')).toEqual([])
  })
})

describe('tsdown presets', () => {
  it('host face: ESM node bundle', () => {
    const config = hostBundle('src/host.ts')
    expect(config.format).toEqual(['esm'])
    expect(config.platform).toBe('node')
  })

  it('client face: CJS browser bundle, seeds external, wrapper welded', () => {
    const packageName = '@scope/my-suite'
    const config = clientBundle(packageName, 'src/client.tsx')
    expect(config.format).toEqual(['cjs'])
    expect(config.platform).toBe('browser')
    expect(config.external).toEqual([...SEED_MODULES])
    const options = typeof config.outputOptions === 'function' ? undefined : config.outputOptions
    const banner = options && 'banner' in options ? String(options.banner) : ''
    const footer = options && 'footer' in options ? String(options.footer) : ''
    expect(banner).toContain(`window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory:`)
    expect(footer).toContain('module.exports.default : module.exports; } });')
  })
})

describe('zod interop sanity', () => {
  it('schema composes with the field base manifest', () => {
    const extended = snapRailManifestSchema.extend({ minHost: z.string() })
    expect(extended.parse({ kind: 'driver', minHost: '0.2.0' })).toMatchObject({ kind: 'driver' })
  })
})
