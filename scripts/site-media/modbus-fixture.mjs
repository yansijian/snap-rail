/**
 * A tiny Modbus TCP fixture for site screenshots and local E2E checks.
 * No dependencies: it speaks just enough of the wire format for the
 * connection-test probe and a few live points.
 *
 *   node scripts/site-media/modbus-fixture.mjs [--port 1502]
 *
 * Registers: 0 = 1843 (count), 1 = 42 (rate), 2.. = 0. Coil 0 = on.
 * Function 17 (report server id) answers an exception; the probe then reads
 * holding register 0, exactly like a real device that does not implement fc17.
 */
import { createServer } from 'node:net'

const portArg = process.argv.indexOf('--port')
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env['MODBUS_PORT'] ?? 1502)

/** Build one MBAP + PDU response. */
function response(transaction, unit, pdu) {
  const frame = Buffer.alloc(7 + pdu.length)
  frame.writeUInt16BE(transaction, 0)
  frame.writeUInt16BE(0, 2)
  frame.writeUInt16BE(1 + pdu.length, 4)
  frame[6] = unit
  pdu.copy(frame, 7)
  return frame
}

/** Exception response (function | 0x80, code). */
function exception(transaction, unit, fc, code) {
  return response(transaction, unit, Buffer.from([fc | 0x80, code]))
}

function handle(socket) {
  let carry = Buffer.alloc(0)
  socket.on('data', chunk => {
    carry = Buffer.concat([carry, chunk])
    while (carry.length >= 8) {
      const length = carry.readUInt16BE(4)
      const total = 6 + length
      if (carry.length < total) return
      const frame = carry.subarray(0, total)
      carry = carry.subarray(total)
      const transaction = frame.readUInt16BE(0)
      const unit = frame[6] ?? 1
      const fc = frame[7] ?? 0
      if (fc === 3 || fc === 4) {
        const address = frame.readUInt16BE(8)
        const count = frame.readUInt16BE(10)
        const pdu = Buffer.alloc(2 + count * 2)
        pdu[0] = fc
        pdu[1] = count * 2
        for (let index = 0; index < count; index += 1) {
          const value = address + index === 0 ? 1843 : address + index === 1 ? 42 : 0
          pdu.writeUInt16BE(value, 2 + index * 2)
        }
        socket.write(response(transaction, unit, pdu))
      } else if (fc === 1 || fc === 2) {
        const count = frame.readUInt16BE(10)
        const bytes = Math.ceil(count / 8)
        const pdu = Buffer.alloc(2 + bytes)
        pdu[0] = fc
        pdu[1] = bytes
        pdu[2] = 0b00000001
        socket.write(response(transaction, unit, pdu))
      } else if (fc === 17) {
        // A valid Report Server ID: byte count 3, server id 1, running 0xff.
        socket.write(response(transaction, unit, Buffer.from([17, 3, 1, 0xff, 0])))
      } else {
        socket.write(exception(transaction, unit, fc, 1))
      }
    }
  })
  socket.on('error', () => {})
}

const server = createServer(handle)
server.listen(port, '127.0.0.1', () => {
  console.log(`modbus-fixture listening on 127.0.0.1:${port}`)
})
