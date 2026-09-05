import { describe, expect, it } from 'vitest'
import { decodeValue, encodeValue, numericValue } from '../src/values.ts'

describe('trend value codec', () => {
  it('round-trips every value kind losslessly', () => {
    const values: Array<string | number | bigint | boolean | null> = [
      true, false, 42, -1.5, 0.1, 0, 9_007_199_254_740_993n, 0n, '', '中文', 'b:x', 'i:not-a-number', 'n:xxx', null,
    ]
    for (const value of values) {
      expect(decodeValue(encodeValue(value))).toBe(value)
    }
  })

  it('keeps 42 and 42n distinct across the store round trip', () => {
    expect(encodeValue(42)).not.toBe(encodeValue(42n))
    expect(decodeValue(encodeValue(42))).toBe(42)
    expect(decodeValue(encodeValue(42n))).toBe(42n)
  })

  it('projects the numeric view the feature extractor works on', () => {
    expect(numericValue(true)).toBe(1)
    expect(numericValue(false)).toBe(0)
    expect(numericValue(42)).toBe(42)
    expect(numericValue(42n)).toBe(42)
    expect(numericValue('hot')).toBeNull()
    expect(numericValue(null)).toBeNull()
  })

  it('fails readable on a corrupt stored value', () => {
    expect(() => decodeValue('zz')).toThrow(/corrupt/)
  })
})
