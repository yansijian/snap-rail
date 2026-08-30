/**
 * The Modbus arithmetic: pure functions for the poll plan (register blocks),
 * payload decoding, and write encoding. No I/O, no state — the unit-testable
 * half of the driver. Word order and register widths are the driver's own
 * dialect concern; nothing here leaks into the field seam.
 *
 * @module @snap-rail/driver-modbus/plc
 */

import type { PointValue } from '@snap-rail/field'
import type { ModbusByteOrder, ModbusFc, ModbusPointConfig } from './contract.ts'

/** Register (or bit) width of one point's payload. */
export function widthOf(point: ModbusPointConfig): number {
  return point.encoding === 'i32' || point.encoding === 'u32' || point.encoding === 'f32' ? 2 : 1
}

/** One merged read: a function code, a start address, a span, and its points. */
export interface PollBlock {
  fc: ModbusFc
  start: number
  /** Bits for fc 1/2, registers for fc 3/4. */
  count: number
  entries: Array<{ point: ModbusPointConfig, offset: number }>
}

/**
 * Group points into as few block reads as possible: same fc, ascending
 * address, merge while the gap to the previous span stays within `gap`
 * units, split when a block would exceed the protocol read limit
 * (125 registers / 2000 bits).
 */
export function planPoll(points: readonly ModbusPointConfig[], gap = 10): PollBlock[] {
  const blocks: PollBlock[] = []
  const byFc = new Map<ModbusFc, ModbusPointConfig[]>()
  for (const point of points) byFc.set(point.fc, [...byFc.get(point.fc) ?? [], point])

  for (const [fc, group] of byFc) {
    const bitMode = fc === 1 || fc === 2
    const limit = bitMode ? 2000 : 125
    const sorted = [...group].sort((a, b) => a.address - b.address)
    let current: PollBlock | undefined
    for (const point of sorted) {
      const width = widthOf(point)
      const span = point.address + width
      if (current !== undefined
        && point.address - (current.start + current.count) <= gap
        && span - current.start <= limit) {
        // Continue the open block.
      } else {
        current = { fc, start: point.address, count: width, entries: [] }
        blocks.push(current)
      }
      current.entries.push({ point, offset: point.address - current.start })
      current.count = Math.max(current.count, point.address - current.start + width)
    }
  }
  return blocks
}

/** Raw bytes of one block read, positioned from the block start. */
export interface BlockPayload {
  bits?: readonly boolean[]
  registers?: readonly number[]
}

/** Decode one point's value out of its block payload (scale applied to f32).
 * Word order is the device-wide link property the caller passes in. */
export function decodePoint(
  point: ModbusPointConfig,
  payload: BlockPayload,
  offset: number,
  byteOrder: ModbusByteOrder,
): PointValue {
  switch (point.encoding) {
    case 'coil':
    case 'discrete':
      return payload.bits?.[offset] ?? false
    case 'i16':
    case 'u16': {
      const raw = payload.registers?.[offset] ?? 0
      return point.encoding === 'i16' ? BigInt((raw << 16) >> 16) : BigInt(raw >>> 0)
    }
    default: {
      const registers = payload.registers ?? [0, 0]
      const [hi, lo] = byteOrder === 'cdab'
        ? [registers[offset + 1] ?? 0, registers[offset] ?? 0]
        : [registers[offset] ?? 0, registers[offset + 1] ?? 0]
      const word = (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0
      if (point.encoding === 'i32') return BigInt(word | 0)
      if (point.encoding === 'u32') return BigInt(word)
      const view = new DataView(new ArrayBuffer(4))
      view.setUint32(0, word)
      return view.getFloat32(0) * (point.scale ?? 1)
    }
  }
}

/** Encode a write: one coil flag or a register array in wire order. */
export function encodeWrite(
  point: ModbusPointConfig,
  value: Exclude<PointValue, null>,
  byteOrder: ModbusByteOrder,
): { coil?: boolean, registers?: number[] } {
  if (point.encoding === 'coil') {
    if (typeof value !== 'boolean') throw new RangeError(`coil write to ${point.var} expects a boolean`)
    return { coil: value }
  }
  if (point.encoding === 'discrete') throw new RangeError(`discrete input ${point.var} is read-only`)
  const number = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (Number.isNaN(number)) throw new RangeError(`write to ${point.var} expects a numeric value`)
  const scale = point.scale ?? 1
  const raw = scale === 1 ? Math.round(number) : Math.round(number / scale)
  switch (point.encoding) {
    case 'i16':
      if (raw < -32_768 || raw > 32_767) throw new RangeError(`value ${number} out of i16 range`)
      return { registers: [raw & 0xffff] }
    case 'u16':
      if (raw < 0 || raw > 65_535) throw new RangeError(`value ${number} out of u16 range`)
      return { registers: [raw & 0xffff] }
    default: {
      let word: number
      if (point.encoding === 'f32') {
        const view = new DataView(new ArrayBuffer(4))
        view.setFloat32(0, number / (point.scale ?? 1))
        word = view.getUint32(0)
      } else if (point.encoding === 'i32') {
        if (raw < -2_147_483_648 || raw > 2_147_483_647) throw new RangeError(`value ${number} out of i32 range`)
        word = raw >>> 0
      } else {
        if (raw < 0 || raw > 4_294_967_295) throw new RangeError(`value ${number} out of u32 range`)
        word = raw >>> 0
      }
      const hi = (word >>> 16) & 0xffff
      const lo = word & 0xffff
      return { registers: byteOrder === 'cdab' ? [lo, hi] : [hi, lo] }
    }
  }
}
