/**
 * The bundled mock field driver: the reference implementation of the field
 * base's driver contract and the acceptance vehicle for client development.
 * Devices, groups, and points live in the base's configuration tables; this
 * driver only simulates their links — points tick on a timer (bool toggles,
 * int counts, float sine wave, string timestamp), `offline: true` parks the
 * device and pushes `null` samples instead. Writes echo back as samples.
 *
 * New driver authors copy this package as their starting point: one
 * registration, two schemas, one connection factory, one update policy.
 *
 * @module @snap-rail/driver-mock
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the driver-registration
// declaration merging alongside the runtime service.
import '@snap-rail/field'
import { z } from 'zod'
import {
  pointKey,
  type DriverConnection,
  type PointRef,
  type PointType,
  type PointValue,
} from '@snap-rail/field'

/** The dialect part of a device config: the simulation's cadence and health.
 * `.meta({ title })` labels the settings form (zod → JSON Schema → SchemaForm). */
export const mockDeviceSchema = z.object({
  offline: z.boolean().default(false).meta({ title: '离线模拟' }),
  periodMs: z.number().int().min(10).max(600_000).default(1_000).meta({ title: '采样周期 (ms)' }),
}).strict()

export type MockDeviceConfig = z.output<typeof mockDeviceSchema>

/** The dialect part of a point config: nothing — the generator follows the
 * group's type (this schema exists to pin the `type` context rule). */
export const mockPointSchema = z.object({
  type: z.enum(['bool', 'int', 'float', 'string']),
}).strict()

/** Build the per-point sample generator for a semantic type. */
function makeGenerator(type: PointType): () => Exclude<PointValue, null> {
  switch (type) {
    case 'bool': {
      let flag = false
      return () => {
        flag = !flag
        return flag
      }
    }
    case 'int': {
      let counter = 0n
      return () => ++counter
    }
    case 'float': {
      const base = Date.now() / 1000
      return () => Math.round(50 * (1 + Math.sin((Date.now() - base) / 500)) * 100) / 100
    }
    case 'string':
      return () => new Date().toISOString()
  }
}

/** One live generator with its field address. */
interface TickEntry {
  ref: PointRef
  next: () => Exclude<PointValue, null>
}

/** The mock driver plugin: registers the adapter with the field base. */
const mockDriverPlugin: Plugin.Object<void> = {
  name: 'driver-mock',
  inject: ['field', 'timer'],
  apply(ctx: Context): void {
    ctx.field.registerDriver(ctx, {
      id: 'mock',
      title: '模拟设备',
      schemas: { device: mockDeviceSchema, point: mockPointSchema },
      createConnection: (device, points, handle): DriverConnection => {
        const config = mockDeviceSchema.parse(device.config)
        /** Generators keyed by composite point key (kept across updates). */
        const entries = new Map<string, TickEntry>()
        const seed = (point: { device: string, group: string, name: string, type: PointType }): void => {
          const key = pointKey(point)
          if (!entries.has(key)) {
            entries.set(key, {
              ref: { device: point.device, group: point.group, name: point.name },
              next: makeGenerator(point.type),
            })
          }
        }
        const tick = (): void => {
          for (const { ref, next } of entries.values()) {
            handle.sample(ref, config.offline ? null : next())
          }
        }
        for (const point of points) seed(point)
        handle.status(config.offline ? 'offline' : 'online')
        if (!config.offline) {
          handle.onWrite((point, value) => {
            handle.sample({ device: point.device, group: point.group, name: point.name }, value)
          })
        }
        let stopInterval = ctx.interval(tick, config.periodMs)

        return {
          update(nextDevice, nextPoints): void {
            const previous = { ...config }
            const next = mockDeviceSchema.parse(nextDevice.config)
            config.offline = next.offline
            config.periodMs = next.periodMs
            for (const point of nextPoints) seed(point)
            for (const key of [...entries.keys()]) {
              if (!nextPoints.some(point => pointKey(point) === key)) entries.delete(key)
            }
            if (config.offline && !previous.offline) handle.status('offline')
            if (!config.offline && previous.offline) handle.status('online')
            if (config.periodMs !== previous.periodMs) {
              stopInterval()
              stopInterval = ctx.interval(tick, config.periodMs)
            }
          },
          dispose(): void {
            stopInterval()
          },
        }
      },
    })
  },
}

export default mockDriverPlugin
