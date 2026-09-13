import { describe, expect, it } from 'vitest'
import {
  CIP_BOOL,
  CIP_DINT,
  CIP_INT,
  CIP_LINT,
  CIP_REAL,
  CIP_SINT,
  ENIP_HEADER_BYTES,
  buildReadTag,
  buildWriteTag,
  busTypeOf,
  cipTypeName,
  decodeReadReply,
  decodeValue,
  encodeValue,
  packHeader,
  packRegisterSession,
  packSendRrData,
  parseHeader,
  unpackSendRrData,
} from '../src/enip.ts'

describe('enip header', () => {
  it('round-trips a command header', () => {
    const frame = packHeader({ command: 0x6f, session: 0x1a2b3c, status: 0, sender: 7n }, Buffer.from([1, 2, 3, 4]))
    expect(frame.length).toBe(ENIP_HEADER_BYTES + 4)
    const header = parseHeader(frame)
    expect(header.command).toBe(0x6f)
    expect(header.session).toBe(0x1a2b3c)
    expect(header.status).toBe(0)
    expect(header.sender).toBe(7n)
    expect(frame.subarray(ENIP_HEADER_BYTES).toString('hex')).toBe('01020304')
  })

  it('rejects frames shorter than the header', () => {
    expect(() => parseHeader(Buffer.alloc(10))).toThrow(/24-byte/)
  })
})

describe('read tag request', () => {
  it('addresses a symbolic segment (golden bytes)', () => {
    // 0x4c, 3 path words, 0x91 + "Temp", one element.
    expect(buildReadTag('Temp', 0).toString('hex')).toBe('4c03910454656d700100')
  })

  it('pads odd-length names to whole words', () => {
    // "Count" (5 chars) pads with one zero; the path spans 4 words.
    expect(buildReadTag('Count', 0).toString('hex')).toBe('4c049105436f756e74000100')
  })

  it('routes through a backplane slot when given', () => {
    // Port segment 01 00 03 rides ahead of the symbolic segment; 5 words.
    expect(buildReadTag('Count', 3).toString('hex')).toBe('4c050100039105436f756e740100')
  })

  it('wraps a SendRRData envelope (golden bytes)', () => {
    const frame = packSendRrData(buildReadTag('Temp', 0), 1n, 0)
    expect(frame.toString('hex')).toBe(
      '6f001a00'
      + '00000000' + '00000000' + '0100000000000000' + '00000000'
      + '00000000' + 'e803' + '0200' + '0000' + '0000' + 'b200' + '0a00'
      + '4c03910454656d700100')
  })

  it('unwraps its own envelope', () => {
    const cip = buildWriteTag('Count', 0, CIP_DINT, encodeValue(CIP_DINT, 8n))
    const frame = packSendRrData(cip, 2n, 0x1a2b3c)
    expect(parseHeader(frame).session).toBe(0x1a2b3c)
    expect(unpackSendRrData(frame).toString('hex')).toBe(cip.toString('hex'))
  })
})

describe('write tag request', () => {
  it('carries the type word, one element, and the data (golden bytes)', () => {
    expect(buildWriteTag('Temp', 0, CIP_DINT, encodeValue(CIP_DINT, 7n)).toString('hex'))
      .toBe('4d03910454656d70c4000100' + '07000000')
  })
})

describe('read tag reply', () => {
  it('decodes scalars of every dialect type', () => {
    expect(decodeReadReply(Buffer.from('cc000000ca000000c842', 'hex')).value).toBeCloseTo(100)
    expect(decodeReadReply(Buffer.from('cc000000c40007000000', 'hex')).value).toBe(7n)
    expect(decodeReadReply(Buffer.from('cc000000c300feff', 'hex')).value).toBe(-2n)
    expect(decodeReadReply(Buffer.from('cc000000c200fe', 'hex')).value).toBe(-2n)
    expect(decodeReadReply(Buffer.from('cc000000c500fdffffffffffffff', 'hex')).value).toBe(-3n)
    expect(decodeReadReply(Buffer.from('cc000000c10001', 'hex')).value).toBe(true)
  })

  it('carries the CIP status at offset 2', () => {
    const failed = decodeReadReply(Buffer.from('cc000500', 'hex'))
    expect(failed.status).toBe(5)
    expect(failed.type).toBeUndefined()
    expect(failed.value).toBeUndefined()
  })

  it('rejects replies shorter than the response header', () => {
    expect(() => decodeReadReply(Buffer.from('cc00', 'hex'))).toThrow(/4-byte/)
  })

  it('rejects unsupported types with the type named', () => {
    expect(() => decodeValue(0xd0, Buffer.alloc(4))).toThrow(/0xd0/)
  })
})

describe('value encoding', () => {
  it('round-trips every dialect type', () => {
    const scalars: ReadonlyArray<readonly [number, boolean | bigint | number]> = [
      [CIP_BOOL, true],
      [CIP_SINT, -2n],
      [CIP_INT, -2n],
      [CIP_DINT, 7n],
      [CIP_LINT, -3n],
      [CIP_REAL, 100],
    ]
    for (const [type, value] of scalars) {
      expect(decodeValue(type, encodeValue(type, value))).toEqual(value)
    }
  })

  it('pins little-endian scalars (golden bytes)', () => {
    expect(encodeValue(CIP_REAL, 1.5).toString('hex')).toBe('0000c03f')
    expect(encodeValue(CIP_DINT, 7n).toString('hex')).toBe('07000000')
    expect(encodeValue(CIP_BOOL, true).toString('hex')).toBe('01')
  })

  it('rejects unsupported types', () => {
    expect(() => encodeValue(0xd0, 1n)).toThrow(/0xd0/)
  })
})

describe('type mapping', () => {
  it('maps CIP words onto the equipment bus', () => {
    expect(busTypeOf(CIP_BOOL)).toBe('bool')
    expect(busTypeOf(CIP_SINT)).toBe('int')
    expect(busTypeOf(CIP_INT)).toBe('int')
    expect(busTypeOf(CIP_DINT)).toBe('int')
    expect(busTypeOf(CIP_LINT)).toBe('int')
    expect(busTypeOf(CIP_REAL)).toBe('float')
    expect(busTypeOf(0xd0)).toBeUndefined()
    expect(cipTypeName(CIP_REAL)).toBe('REAL')
  })
})

describe('register session', () => {
  it('requests protocol version 1', () => {
    expect(packRegisterSession().toString('hex')).toBe('01000000')
  })
})
