/**
 * The in-process fake PLC: modbus-serial ServerTCP servers bound to one
 * ephemeral port with addressable holding registers and coils. `stop()`
 * closes the listener; `restart()` binds a fresh server on the same port
 * with the same registers (modbus-serial's ServerTCP cannot re-listen after
 * close). Lives in this package so its `modbus-serial` import resolves.
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
  stop(): Promise<void>
  restart(register: (server: { close: (cb: () => void) => void }) => void): Promise<void>
}

/** Start a fake PLC on a free port; every server instance is handed to the
 * caller's cleanup register (initial and restarted alike). */
export async function startFakePlc(
  register: (server: { close: (cb: () => void) => void }) => void,
): Promise<FakePlc> {
  const netProbe = net.createServer()
  await new Promise<void>(resolve => netProbe.listen(0, '127.0.0.1', resolve))
  const port = (netProbe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => netProbe.close(() => resolve()))

  const holding = new Map<number, number>()
  const coils = new Map<number, boolean>()
  const vector = {
    getHoldingRegister: (addr: number): number => holding.get(addr) ?? 0,
    getCoil: (addr: number): boolean => coils.get(addr) ?? false,
    setCoil: (addr: number, value: boolean): void => { coils.set(addr, value) },
  }
  const listen = (): Promise<{ close: (cb: () => void) => void }> => {
    const server = new ServerTCP(vector, { host: '127.0.0.1', port, unitID: 1 })
    return new Promise(resolve => server.on('initialized', () => resolve(server)))
  }

  const initial = await listen()
  register(initial)
  return {
    port,
    holding,
    coils,
    stop: () => new Promise<void>(resolve => initial.close(() => resolve())),
    restart: async reRegister => reRegister(await listen()),
  }
}

/** Register pair encoding an IEEE-754 float32 (big-endian word first). */
export function floatRegs(value: number): number[] {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value)
  return [view.getUint16(0), view.getUint16(2)]
}
