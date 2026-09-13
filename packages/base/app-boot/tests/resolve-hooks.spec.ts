import { describe, expect, it } from 'vitest'
import { anchorSpineResolution, isAnchoredSpecifier, poolPredicate } from '../src/resolve-hooks.ts'
import { poolSubpathFile } from '../src/scan.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('spine resolution anchoring', () => {
  it('anchors the spine scope, zod, and drizzle-orm, nothing else', () => {
    expect(isAnchoredSpecifier('@snap-rail/equipment')).toBe(true)
    expect(isAnchoredSpecifier('@snap-rail/suite-terminal-ops/stats')).toBe(true)
    expect(isAnchoredSpecifier('zod')).toBe(true)
    // drizzle table objects cross the store seam, so pool plugins share the
    // host's instance just like zod schemas — subpaths anchor too.
    expect(isAnchoredSpecifier('drizzle-orm')).toBe(true)
    expect(isAnchoredSpecifier('drizzle-orm/sqlite-core')).toBe(true)
    expect(isAnchoredSpecifier('zod/v4')).toBe(true)
    // Relative, absolute, and file URLs keep their own resolution; foreign
    // packages resolve from the importing file like always.
    expect(isAnchoredSpecifier('./sibling.ts')).toBe(false)
    expect(isAnchoredSpecifier('modbus-serial')).toBe(false)
    expect(isAnchoredSpecifier('node:fs')).toBe(false)
    expect(isAnchoredSpecifier('file:///D:/x/lib/index.js')).toBe(false)
    expect(isAnchoredSpecifier('@types/node')).toBe(false)
  })

  it('only re-anchors imports whose parent lives in the pool', () => {
    const pool = join(tmpdir(), 'snap-rail-home', 'plugins')
    const inPool = poolPredicate([pool])
    const inside = pathToFileURL(join(pool, 'suite-x', 'lib', 'index.js')).href
    const outside = pathToFileURL(join(tmpdir(), 'app', 'lib', 'index.js')).href
    expect(inPool(inside)).toBe(true)
    expect(inPool(`${inside}?query`)).toBe(true)
    expect(inPool(outside)).toBe(false)
    expect(inPool(undefined)).toBe(false)
  })

  it('installs once per process (repeat calls are no-ops)', () => {
    expect(() => {
      anchorSpineResolution(process.cwd(), [])
      anchorSpineResolution(process.cwd(), [])
    }).not.toThrow()
  })
})

describe('pool subpath resolution (the appRoot-first fallback target)', () => {
  const dirs: string[] = []
  const makePackage = (manifest: Record<string, unknown>, files: Record<string, string> = {}): string => {
    const dir = join(mkdtempSync(join(tmpdir(), 'snap-rail-poolsub-')), '@snap-rail__pkg')
    dirs.push(dirname(dir))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body)
    }
    return dir
  }
  const cleanup = (): void => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  it('resolves the root through main and subpaths through the exports voice', () => {
    const dir = makePackage(
      { name: '@snap-rail/pkg', main: 'lib/index.js', exports: { '.': './lib/index.js', './rpc': './lib/rpc.js' } },
      { 'lib/index.js': '', 'lib/rpc.js': '' },
    )
    try {
      expect(poolSubpathFile(dir, '.')).toBe(join(dir, 'lib', 'index.js'))
      expect(poolSubpathFile(dir, './rpc')).toBe(join(dir, 'lib', 'rpc.js'))
      // No voice for it: no such subpath.
      expect(poolSubpathFile(dir, './missing')).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('falls back to <subpath>.js and <subpath>/index.js when no exports map exists', () => {
    const dir = makePackage({ name: '@snap-rail/pkg', main: 'lib/index.js' }, { 'lib/index.js': '' })
    try {
      expect(poolSubpathFile(dir, '.')).toBe(join(dir, 'lib', 'index.js'))
      expect(poolSubpathFile(dir, './direct')).toBeUndefined()
      writeFileSync(join(dir, 'direct.js'), '')
      expect(poolSubpathFile(dir, './direct')).toBe(join(dir, 'direct.js'))
    } finally {
      cleanup()
    }
  })

  it('returns undefined for a broken manifest', () => {
    const dir = makePackage({ name: '@snap-rail/pkg' })
    writeFileSync(join(dir, 'package.json'), '{ not json')
    try {
      expect(poolSubpathFile(dir, '.')).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
