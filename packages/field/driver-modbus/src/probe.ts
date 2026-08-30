/**
 * The connection probe behind `field.modbus.devices.test`: a one-shot
 * ModbusTCP client that connects and reads a single register. Isolated from
 * the bridge so the subpath never drags the driver runtime in.
 *
 * @module @snap-rail/driver-modbus/probe
 */

import ModbusRTU from 'modbus-serial'
import type { ModbusDeviceConfig } from './contract.ts'

/** Probe one device address without touching the stored table. */
export async function probeDevice(device: ModbusDeviceConfig): Promise<{ ok: true } | { ok: false, error: string }> {
  const client = new ModbusRTU()
  try {
    await client.connectTCP(device.host, { port: device.port })
    client.setID(device.unitId)
    client.setTimeout(device.timeoutMs)
    // A minimal register read proves the unit answers, not just the socket.
    await client.readHoldingRegisters(0, 1)
    return { ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    try {
      if (client.isOpen) client.close(() => {})
    } catch {
      // Test client disposal is best-effort.
    }
  }
}
