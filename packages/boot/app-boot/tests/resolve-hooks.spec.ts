import { describe, expect, it } from 'vitest'
import { anchorSpineResolution, isAnchoredSpecifier, poolPredicate } from '../src/resolve-hooks.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('spine resolution anchoring', () => {
  it('anchors the spine scope and zod, nothing else', () => {
    expect(isAnchoredSpecifier('@snap-rail/field')).toBe(true)
    expect(isAnchoredSpecifier('@snap-rail/suite-terminal-ops/stats')).toBe(true)
    expect(isAnchoredSpecifier('zod')).toBe(true)
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
