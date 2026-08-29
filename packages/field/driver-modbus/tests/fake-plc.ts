/**
 * The in-process fake PLC: a modbus-serial ServerTCP bound to an ephemeral
 * port with addressable holding registers and coils. Lives in this package
 * so its `modbus-serial` import resolves; UI specs import it from here.
 *
 * @module @snap-rail/driver-modbus/tests/fake-plc
 */

import * as net from 'node:net'
import modbusSerial from 'modbus-serial'

const { ServerTCP } = modbusSerial as unknown as {
  ServerTCP: new (vector: Record<string, unknown>, options: { host?: string, port?: number, unitID?: number }) => {
    on(event: string, cb: () => void): void
    close(cb: () => void): void
  }
}

export interface FakePlc {
  port: number
  holding: Map<number, number>
  coils: Map<number, boolean>
}

/** Start a fake PLC on a free port; register the server for caller cleanup. */
export async function startFakePlc(register: (server: { close: (cb: () => void) => void }) => void): Promise<FakePlc> {
  const netProbe = net.createServer()
  await new Promise<void>(resolve => netProbe.listen(0, '127.0.0.1', resolve))
  const port = (netProbe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => netProbe.close(() => resolve()))

  const holding = new Map<number, number>()
  const coils = new Map<number, boolean>()
  const server = new ServerTCP(
    {
      getHoldingRegister: (addr: number): number => holding.get(addr) ?? 0,
      getCoil: (addr: number): boolean => coils.get(addr) ?? false,
      setCoil: (addr: number, value: boolean): void => { coils.set(addr, value) },
    },
    { host: '127.0.0.1', port, unitID: 1 },
  )
  await new Promise<void>(resolve => server.on('initialized', resolve))
  register(server)
  return { port, holding, coils }
}

/** Register pair encoding an IEEE-754 float32 (big-endian word first). */
export function floatRegs(value: number): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  return [view.getUint16(0), view.getUint16(2)]
}
