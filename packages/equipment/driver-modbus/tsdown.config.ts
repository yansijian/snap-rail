import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'

/**
 * The modbus driver ships two faces: the host adapter (index) and the pure
 * wire-contract subpath (contract). The protocol library rides inside the
 * host bundle — a driver-internal library never joins the anchored shared
 * vocabulary (zod, drizzle-orm, @snap-rail/*), so the installable zip is
 * self-contained. Entries are the JS tsc emits under lib/types.
 */

/**
 * The no-serial-port fork still references `serialport` from its serial port
 * classes; the TCP driver never touches them, and at runtime the require
 * already fails into "port type unavailable". Resolve the id to an empty
 * module so the bundle keeps that behavior without a native dependency.
 */
const serialPortStub: Plugin = {
  name: 'stub-serialport',
  resolveId(id) {
    return id === 'serialport' ? '\0serialport-stub' : undefined
  },
  load(id) {
    return id === '\0serialport-stub' ? 'export default {}' : undefined
  },
}

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

export default defineConfig([
  {
    ...shared,
    entry: ['lib/types/index.js'],
    noExternal: ['modbus-serial'],
    plugins: [serialPortStub],
  },
  { ...shared, entry: ['lib/types/contract.js'] },
])
