/**
 * The in-process fake PLC: a hand-rolled ENIP server speaking exactly the
 * subset the driver does — RegisterSession and SendRRData carrying CIP
 * Read/Write Tag requests addressed by symbolic segments (the Omron
 * NX/NX1P2 shape: no route path, published global variables). The tag
 * store is addressable from tests; `stop()` drops every connection,
 * `restart()` re-listens on the same port with the same values. Only the
 * 24-byte header size is shared with the driver — the CPF/CIP layers are
 * re-derived here so a codec bug cannot hide behind its own twin.
 *
 * @module @snap-rail/driver-enip/tests/fake-plc
 */

import * as net from 'node:net'
import { ENIP_HEADER_BYTES } from '../src/enip.ts'

/** One published variable: its CIP type word and live scalar value. */
export interface FakeTag {
  type: number
  value: boolean | number | bigint
}

export interface FakePlc {
  port: number
  /** The published variable table; tests mutate values directly. */
  tags: Map<string, FakeTag>
  stop(): Promise<void>
  restart(register: (server: net.Server) => void): Promise<void>
}

/** Start a fake PLC on a free port; every server instance is handed to the
 * caller's cleanup register (initial and restarted alike). */
export async function startFakePlc(
  register: (server: net.Server) => void,
): Promise<FakePlc> {
  const netProbe = net.createServer()
  await new Promise<void>(resolve => netProbe.listen(0, '127.0.0.1', resolve))
  const port = (netProbe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => netProbe.close(() => resolve()))

  const tags = new Map<string, FakeTag>()
  const sockets = new Set<net.Socket>()
  let nextSession = 0x1a2b3c00

  const listen = (): Promise<net.Server> => new Promise(resolve => {
    const server = net.createServer()
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      let carry = Buffer.alloc(0)
      socket.on('data', chunk => {
        carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
        while (carry.length >= ENIP_HEADER_BYTES) {
          const total = ENIP_HEADER_BYTES + carry.readUInt16LE(2)
          if (carry.length < total) break
          const frame = carry.subarray(0, total)
          carry = carry.subarray(total)
          serve(socket, frame)
        }
      })
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })

  function serve(socket: net.Socket, frame: Buffer): void {
    const command = frame.readUInt16LE(0)
    const session = frame.readUInt32LE(4)
    const sender = frame.readBigUInt64LE(12)
    const body = frame.subarray(ENIP_HEADER_BYTES)
    if (command === 0x65) {
      // RegisterSession: echo the body under a fresh session handle.
      write(socket, 0x65, nextSession, sender, body.subarray(0, 4))
      nextSession += 1
      return
    }
    if (command === 0x6f) {
      write(socket, 0x6f, session, sender, wrapCpf(serveCip(unconnected(body))))
      return
    }
    write(socket, command, session, sender, Buffer.alloc(0))
  }

  /** Pull the unconnected data item out of a SendRRData body. */
  function unconnected(body: Buffer): Buffer {
    const length = body.readUInt16LE(14)
    return body.subarray(16, 16 + length)
  }

  /** Wrap a CIP reply the way a SendRRData body expects. */
  function wrapCpf(cip: Buffer): Buffer {
    const body = Buffer.alloc(16 + cip.length)
    body.writeUInt16LE(2, 6)
    body.writeUInt16LE(0xb2, 12)
    body.writeUInt16LE(cip.length, 14)
    cip.copy(body, 16)
    return body
  }

  function write(socket: net.Socket, command: number, session: number, sender: bigint, body: Buffer): void {
    const frame = Buffer.alloc(ENIP_HEADER_BYTES + body.length)
    frame.writeUInt16LE(command, 0)
    frame.writeUInt16LE(body.length, 2)
    frame.writeUInt32LE(session, 4)
    frame.writeBigUInt64LE(sender, 12)
    frame.set(body, ENIP_HEADER_BYTES)
    socket.write(frame)
  }

  /** One CIP message-router request → reply (Read/Write Tag, symbolic path). */
  function serveCip(cip: Buffer): Buffer {
    const service = cip.readUInt8(0)
    const pathWords = cip.readUInt8(1)
    const path = cip.subarray(2, 2 + pathWords * 2)
    const data = cip.subarray(2 + pathWords * 2)
    if (service === 0x4c) {
      const tag = tags.get(symbolicName(path))
      if (tag === undefined) return failure(0xcc, 0x05)
      const value = encodeScalar(tag.type, tag.value)
      const reply = Buffer.alloc(6 + value.length)
      reply.writeUInt8(0xcc, 0)
      reply.writeUInt16LE(tag.type, 4)
      value.copy(reply, 6)
      return reply
    }
    if (service === 0x4d) {
      const tag = tags.get(symbolicName(path))
      if (tag === undefined) return failure(0xcd, 0x05)
      const type = data.readUInt16LE(0)
      if (type !== tag.type) return failure(0xcd, 0x06)
      tag.value = decodeScalar(type, data.subarray(4))
      return Buffer.from([0xcd, 0x00, 0x00, 0x00])
    }
    return failure(service + 0x80, 0x08)
  }

  /** A bare CIP error reply: service + 0x80, reserved, status, ext size 0. */
  function failure(service: number, status: number): Buffer {
    return Buffer.from([service, 0x00, status, 0x00])
  }

  /** Extract the symbolic name from a message path (port segments skipped). */
  function symbolicName(path: Buffer): string {
    let at = 0
    while (at < path.length) {
      if (path[at] === 0x91) {
        const length = path[at + 1] ?? 0
        return path.subarray(at + 2, at + 2 + length).toString('ascii')
      }
      // A backplane port segment spans three bytes (01 00 <slot>).
      at += 3
    }
    return ''
  }

  /** The byte width of one elementary scalar. */
  function widthOf(type: number): number {
    switch (type) {
      case 0xc1:
      case 0xc2: return 1
      case 0xc3: return 2
      case 0xc4:
      case 0xca: return 4
      case 0xc5: return 8
      default: throw new Error(`fake plc cannot size type 0x${type.toString(16)}`)
    }
  }

  function encodeScalar(type: number, value: boolean | number | bigint): Buffer {
    const data = Buffer.alloc(widthOf(type))
    switch (type) {
      case 0xc1: data.writeUInt8(value ? 1 : 0, 0); break
      case 0xc2: data.writeInt8(Number(value), 0); break
      case 0xc3: data.writeInt16LE(Number(value), 0); break
      case 0xc4: data.writeInt32LE(Number(value), 0); break
      case 0xc5: data.writeBigInt64LE(BigInt(value), 0); break
      case 0xca: data.writeFloatLE(Number(value), 0); break
      default: throw new Error(`fake plc cannot encode type 0x${type.toString(16)}`)
    }
    return data
  }

  function decodeScalar(type: number, data: Buffer): boolean | number | bigint {
    switch (type) {
      case 0xc1: return data[0] !== 0
      case 0xc2: return data.readInt8(0)
      case 0xc3: return data.readInt16LE(0)
      case 0xc4: return data.readInt32LE(0)
      case 0xc5: return data.readBigInt64LE(0)
      case 0xca: return data.readFloatLE(0)
      default: throw new Error(`fake plc cannot decode type 0x${type.toString(16)}`)
    }
  }

  const initial = await listen()
  register(initial)
  return {
    port,
    tags,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>(resolve => initial.close(() => resolve()))
    },
    restart: async reRegister => reRegister(await listen()),
  }
}
