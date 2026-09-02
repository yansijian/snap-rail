import { describe, expect, it } from 'vitest'
import { decodePoint, encodeWrite, planPoll, widthOf, type PlannedPoint } from '../src/plc.ts'

function point(overrides: Partial<PlannedPoint> & { var: string }): PlannedPoint {
  return {
    type: 'int',
    fc: 3,
    address: 0,
    encoding: 'u16',
    writable: false,
    ref: { device: 'plc1', group: '测试', name: overrides.var },
    ...overrides,
  }
}

/** Register pair encoding an IEEE-754 float32 (big-endian word first). */
function floatRegs(value: number, order: 'abcd' | 'cdab' = 'abcd'): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  const hi = view.getUint16(0)
  const lo = view.getUint16(2)
  return order === 'cdab' ? [lo, hi] : [hi, lo]
}

describe('planPoll', () => {
  it('merges nearby registers per fc and keeps distant ones apart', () => {
    const blocks = planPoll([
      point({ var: '温度1', encoding: 'f32', type: 'float', address: 100 }),
      point({ var: '计数1', encoding: 'u32', address: 104 }),
      point({ var: '压力1', encoding: 'i16', address: 200 }),
      point({ var: '开关1', encoding: 'coil', type: 'bool', fc: 1, address: 10 }),
      point({ var: '开关2', encoding: 'coil', type: 'bool', fc: 1, address: 15 }),
    ])
    expect(blocks).toHaveLength(3)

    const holding = blocks.find(block => block.fc === 3 && block.start === 100)
    expect(holding?.count).toBe(6) // 100..105 covers both two-register points
    // Entries keep ascending-address order.
    expect(holding?.entries.map(entry => entry.point.ref.name)).toEqual(['温度1', '计数1'])
    expect(blocks.some(block => block.fc === 3 && block.start === 200)).toBe(true)
    const coils = blocks.find(block => block.fc === 1)
    expect(coils?.count).toBe(6) // bits 10..15
  })

  it('splits blocks that exceed the protocol read limit', () => {
    // 70 u16 points at even addresses 0..138: one register wide each.
    const many = Array.from({ length: 70 }, (_, index) =>
      point({ var: `m${index}`, address: index * 2 }))
    const blocks = planPoll(many)
    expect(blocks.every(block => block.count <= 125)).toBe(true)
    // The limit split leaves the register under the boundary as a hole
    // (0..124 then 126..138); every point stays covered by exactly one block.
    expect(blocks.map(block => [block.start, block.count])).toEqual([[0, 125], [126, 13]])
    const covered = blocks.flatMap(block =>
      block.entries.map(entry => entry.point.ref.name))
    expect(new Set(covered).size).toBe(70)
  })

  it('computes widths per encoding', () => {
    expect(widthOf(point({ var: 'a', encoding: 'i16' }))).toBe(1)
    expect(widthOf(point({ var: 'b', encoding: 'f32', type: 'float' }))).toBe(2)
  })
})

describe('decodePoint', () => {
  it('sign-extends i16 and reads u16 unsigned', () => {
    expect(decodePoint(point({ var: 'a', encoding: 'i16' }), { registers: [0xfffe] }, 0, 'abcd')).toBe(-2n)
    expect(decodePoint(point({ var: 'b', encoding: 'u16' }), { registers: [0xfffe] }, 0, 'abcd')).toBe(65534n)
  })

  it('decodes i32/u32 in both word orders (the device-wide property)', () => {
    const negative = point({ var: 'a', encoding: 'i32' })
    expect(decodePoint(negative, { registers: [0xffff, 0xfffe] }, 0, 'abcd')).toBe(-2n)
    expect(decodePoint(negative, { registers: [0xfffe, 0xffff] }, 0, 'cdab')).toBe(-2n)
    const wide = point({ var: 'c', encoding: 'u32' })
    expect(decodePoint(wide, { registers: [1, 0] }, 0, 'abcd')).toBe(65536n)
  })

  it('decodes f32 with word order and applies scale', () => {
    const plain = point({ var: 'a', encoding: 'f32', type: 'float' })
    expect(decodePoint(plain, { registers: floatRegs(23.5) }, 0, 'abcd')).toBeCloseTo(23.5)
    expect(decodePoint(plain, { registers: floatRegs(23.5, 'cdab') }, 0, 'cdab')).toBeCloseTo(23.5)
    const scaled = point({ var: 'c', encoding: 'f32', type: 'float', scale: 0.1 })
    expect(decodePoint(scaled, { registers: floatRegs(100) }, 0, 'abcd')).toBeCloseTo(10)
  })

  it('reads coils as booleans', () => {
    const coil = point({ var: 'a', encoding: 'coil', type: 'bool', fc: 1 })
    expect(decodePoint(coil, { bits: [false, true] }, 1, 'abcd')).toBe(true)
  })
})

describe('encodeWrite', () => {
  it('encodes coils from booleans only', () => {
    const coil = point({ var: 'a', encoding: 'coil', type: 'bool', fc: 1, writable: true })
    expect(encodeWrite(coil, true, 'abcd')).toEqual({ coil: true })
    expect(() => encodeWrite(coil, 1, 'abcd')).toThrow(/boolean/)
  })

  it('range-checks and encodes 16-bit registers', () => {
    const u16 = point({ var: 'a', encoding: 'u16', writable: true })
    expect(encodeWrite(u16, 65535n, 'abcd')).toEqual({ registers: [65535] })
    expect(() => encodeWrite(u16, 65536n, 'abcd')).toThrow(/range/)
    const i16 = point({ var: 'b', encoding: 'i16', writable: true })
    expect(encodeWrite(i16, -2n, 'abcd')).toEqual({ registers: [0xfffe] })
  })

  it('encodes 32-bit words in the configured order', () => {
    const big = point({ var: 'a', encoding: 'i32', writable: true })
    expect(encodeWrite(big, -2n, 'abcd')).toEqual({ registers: [0xffff, 0xfffe] })
    expect(encodeWrite(big, -2n, 'cdab')).toEqual({ registers: [0xfffe, 0xffff] })
  })

  it('reverses scale on f32 writes', () => {
    const scaled = point({ var: 'a', encoding: 'f32', type: 'float', scale: 0.1, writable: true })
    const encoded = encodeWrite(scaled, 10, 'abcd')
    const view = new DataView(new ArrayBuffer(4))
    view.setUint16(0, encoded.registers![0] as number)
    view.setUint16(2, encoded.registers![1] as number)
    expect(view.getFloat32(0)).toBeCloseTo(100)
  })
})
