/**
 * The EtherNet/IP wire subset this driver speaks, as pure codecs (I/O-free):
 * the 24-byte ENIP command header, RegisterSession, and CPF-enveloped
 * SendRRData carrying CIP message-router requests — Read Tag / Write Tag
 * addressed by an ANSI extended symbolic segment. Everything is
 * little-endian. The CIP reply wears a 4-byte response header (reply
 * service, reserved, status at offset 2, additional-status size at offset
 * 3) — the layout observed on real NX/NX1P2 targets; request paths pad to
 * whole 16-bit words. The socket shell lives in the index runtime; the
 * fake PLC in tests reuses only the header constants, so a codec bug
 * cannot hide behind its own twin.
 *
 * @module @snap-rail/driver-enip/enip
 */

/** ENIP commands (the envelope's whole diet). */
export const COMMAND_REGISTER_SESSION = 0x65
export const COMMAND_SEND_RR_DATA = 0x6f

/** CIP services this dialect touches. */
export const SERVICE_READ_TAG = 0x4c
export const SERVICE_WRITE_TAG = 0x4d

/** CIP elementary type words (the reply's type field; the dialect's diet). */
export const CIP_BOOL = 0xc1
export const CIP_SINT = 0xc2
export const CIP_INT = 0xc3
export const CIP_DINT = 0xc4
export const CIP_LINT = 0xc5
export const CIP_REAL = 0xca

/** The bus type an elementary CIP word carries; undefined = out of scope. */
export function busTypeOf(type: number): 'bool' | 'int' | 'float' | undefined {
  switch (type) {
    case CIP_BOOL: return 'bool'
    case CIP_SINT:
    case CIP_INT:
    case CIP_DINT:
    case CIP_LINT: return 'int'
    case CIP_REAL: return 'float'
    default: return undefined
  }
}

/** The CIP type's spelling for error messages. */
export function cipTypeName(type: number): string {
  const names: Record<number, string> = {
    [CIP_BOOL]: 'BOOL',
    [CIP_SINT]: 'SINT',
    [CIP_INT]: 'INT',
    [CIP_DINT]: 'DINT',
    [CIP_LINT]: 'LINT',
    [CIP_REAL]: 'REAL',
  }
  return names[type] ?? `0x${type.toString(16)}`
}

/** One scalar as it rides the equipment bus (ints as bigint). */
export type ScalarValue = boolean | bigint | number

/** The ENIP command header every frame wears. */
export interface EnipHeader {
  command: number
  length: number
  session: number
  status: number
  /** Correlation token; replies echo it verbatim. */
  sender: bigint
}

export const ENIP_HEADER_BYTES = 24

/** Wrap a command payload in its 24-byte header (sender context at 12). */
export function packHeader(header: Omit<EnipHeader, 'length'>, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(ENIP_HEADER_BYTES + payload.length)
  frame.writeUInt16LE(header.command, 0)
  frame.writeUInt16LE(payload.length, 2)
  frame.writeUInt32LE(header.session, 4)
  frame.writeUInt32LE(header.status, 8)
  frame.writeBigUInt64LE(BigInt.asUintN(64, header.sender), 12)
  frame.writeUInt32LE(0, 20)
  frame.set(payload, ENIP_HEADER_BYTES)
  return frame
}

/** Parse a frame's header; the payload is the frame's tail. */
export function parseHeader(frame: Buffer): EnipHeader {
  if (frame.length < ENIP_HEADER_BYTES) {
    throw new Error(`ENIP frame shorter than the ${ENIP_HEADER_BYTES}-byte header`)
  }
  return {
    command: frame.readUInt16LE(0),
    length: frame.readUInt16LE(2),
    session: frame.readUInt32LE(4),
    status: frame.readUInt32LE(8),
    sender: frame.readBigUInt64LE(12),
  }
}

/** A RegisterSession body: protocol version 1, options 0. */
export function packRegisterSession(): Buffer {
  const body = Buffer.alloc(4)
  body.writeUInt16LE(1, 0)
  return body
}

/** Encode the message path for one variable: the ANSI extended symbolic
 * segment (0x91 + name), preceded by a backplane port segment when a slot
 * is given (0 routes straight to the port — the Omron built-in case). The
 * path always spans whole words. */
export function packPath(tag: string, slot: number): Buffer {
  const name = Buffer.from(tag, 'ascii')
  const segments = Buffer.concat([
    slot > 0 ? Buffer.from([0x01, 0x00, slot]) : Buffer.alloc(0),
    Buffer.from([0x91, name.length]),
    name,
  ])
  return segments.length % 2 === 0 ? segments : Buffer.concat([segments, Buffer.from([0])])
}

/** A Read Tag request for one element (scalars are the dialect's diet). */
export function buildReadTag(tag: string, slot: number): Buffer {
  const path = packPath(tag, slot)
  const cip = Buffer.alloc(4 + path.length)
  cip.writeUInt8(SERVICE_READ_TAG, 0)
  cip.writeUInt8(path.length / 2, 1)
  path.copy(cip, 2)
  cip.writeUInt16LE(1, 2 + path.length)
  return cip
}

/** A Write Tag request: the type word, one element, little-endian data. */
export function buildWriteTag(tag: string, slot: number, type: number, data: Uint8Array): Buffer {
  const path = packPath(tag, slot)
  const cip = Buffer.alloc(6 + path.length + data.length)
  cip.writeUInt8(SERVICE_WRITE_TAG, 0)
  cip.writeUInt8(path.length / 2, 1)
  path.copy(cip, 2)
  cip.writeUInt16LE(type, 2 + path.length)
  cip.writeUInt16LE(1, 2 + path.length + 2)
  cip.set(data, 2 + path.length + 4)
  return cip
}

/** Wrap a CIP request in a SendRRData command frame (null address item +
 * unconnected data item — UCMM, the shape NX/NX1P2 serves). */
export function packSendRrData(cip: Uint8Array, sender: bigint, session: number): Buffer {
  const body = Buffer.alloc(16 + cip.length)
  // The unconnected-request timeout the target should honor (ms-ish ticks).
  body.writeUInt16LE(1000, 4)
  body.writeUInt16LE(2, 6)
  body.writeUInt16LE(0xb2, 12)
  body.writeUInt16LE(cip.length, 14)
  body.set(cip, 16)
  return packHeader({ command: COMMAND_SEND_RR_DATA, session, status: 0, sender }, body)
}

/** Unwrap a SendRRData reply frame down to its CIP body. */
export function unpackSendRrData(frame: Buffer): Buffer {
  const header = parseHeader(frame)
  if (header.command !== COMMAND_SEND_RR_DATA) {
    throw new Error(`expected SendRRData reply, got command 0x${header.command.toString(16)}`)
  }
  if (header.status !== 0) {
    throw new Error(`SendRRData failed with ENIP status ${header.status}`)
  }
  const body = frame.subarray(ENIP_HEADER_BYTES)
  if (body.length < 16 || body.readUInt16LE(6) < 2 || body.readUInt16LE(12) !== 0xb2) {
    throw new Error('SendRRData reply carries no unconnected data item')
  }
  const length = body.readUInt16LE(14)
  return body.subarray(16, 16 + length)
}

/** One decoded Read Tag reply. */
export interface ReadReply {
  /** CIP general status; 0 = success. */
  status: number
  /** The reply's type word; undefined unless status is 0. */
  type: number | undefined
  /** The decoded scalar; undefined unless status is 0. */
  value: ScalarValue | undefined
}

/** Decode a Read Tag reply body: the 4-byte CIP response header, then on
 * success the type word and little-endian data. */
export function decodeReadReply(cip: Buffer): ReadReply {
  if (cip.length < 4) {
    throw new Error('CIP reply shorter than the 4-byte response header')
  }
  const status = cip.readUInt8(2)
  if (status !== 0) return { status, type: undefined, value: undefined }
  if (cip.length < 6) {
    throw new Error('CIP reply success without a type word')
  }
  const type = cip.readUInt16LE(4)
  return { status: 0, type, value: decodeValue(type, cip.subarray(6)) }
}

/** Decode one elementary scalar; ints ride the bus as bigint. */
export function decodeValue(type: number, data: Buffer): ScalarValue {
  switch (type) {
    case CIP_BOOL: return (data[0] ?? 0) !== 0
    case CIP_SINT: return BigInt(data.readInt8(0))
    case CIP_INT: return BigInt(data.readInt16LE(0))
    case CIP_DINT: return BigInt(data.readInt32LE(0))
    case CIP_LINT: return data.readBigInt64LE(0)
    case CIP_REAL: return data.readFloatLE(0)
    default: throw new Error(`unsupported CIP type ${cipTypeName(type)} — arrays and structures are out of the dialect's v1 scope`)
  }
}

/** Encode one bus value for a CIP type (the write path). */
export function encodeValue(type: number, value: Exclude<ScalarValue, undefined>): Buffer {
  switch (type) {
    case CIP_BOOL: return Buffer.from([value ? 1 : 0])
    case CIP_SINT: return Buffer.from([Number(value) & 0xff])
    case CIP_INT: {
      const data = Buffer.alloc(2)
      data.writeInt16LE(Number(value), 0)
      return data
    }
    case CIP_DINT: {
      const data = Buffer.alloc(4)
      data.writeInt32LE(Number(value), 0)
      return data
    }
    case CIP_LINT: {
      const data = Buffer.alloc(8)
      data.writeBigInt64LE(BigInt(value), 0)
      return data
    }
    case CIP_REAL: {
      const data = Buffer.alloc(4)
      data.writeFloatLE(Number(value), 0)
      return data
    }
    default: throw new Error(`unsupported CIP type ${cipTypeName(type)} — arrays and structures are out of the dialect's v1 scope`)
  }
}
