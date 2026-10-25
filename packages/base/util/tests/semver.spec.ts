import { describe, expect, it } from 'vitest'
import { compareVersions, satisfiesRange, splitNameRange } from '../src/semver.ts'

describe('compareVersions', () => {
  it('orders core segments numerically and prereleases before their release', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })
})

describe('satisfiesRange', () => {
  it('supports caret, tilde, comparison, and exact ranges', () => {
    expect(satisfiesRange('1.4.0', '^1.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.0')).toBe(false)
    expect(satisfiesRange('1.3.5', '~1.3')).toBe(true)
    expect(satisfiesRange('1.4.0', '~1.3')).toBe(false)
    expect(satisfiesRange('1.9.9', '~1.3')).toBe(false)
    expect(satisfiesRange('1.4.0', '>=1.4.0')).toBe(true)
    expect(satisfiesRange('1.3.9', '>=1.4.0')).toBe(false)
    expect(satisfiesRange('1.4.1', '<2.0.0')).toBe(true)
    expect(satisfiesRange('1.4.0', '1.4.0')).toBe(true)
    expect(satisfiesRange('1.4.1', '1.4.0')).toBe(false)
  })

  it('an unparsable range or version satisfies nothing', () => {
    expect(satisfiesRange('abc', '^1.0')).toBe(false)
    expect(satisfiesRange('1.0.0', 'not-a-range')).toBe(false)
  })
})

describe('splitNameRange', () => {
  it('splits scoped and bare names at the last separator', () => {
    expect(splitNameRange('@snap-rail/equipment@^0.1')).toEqual({ name: '@snap-rail/equipment', range: '^0.1' })
    expect(splitNameRange('pkg@1.2.0')).toEqual({ name: 'pkg', range: '1.2.0' })
    expect(splitNameRange('@snap-rail/equipment')).toEqual({ name: '@snap-rail/equipment' })
    expect(splitNameRange('service:store')).toEqual({ name: 'service:store' })
    // A trailing @ names no range — treat the whole entry as the name.
    expect(splitNameRange('pkg@')).toEqual({ name: 'pkg@' })
  })
})
