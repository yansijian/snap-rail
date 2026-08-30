/**
 * The bundled mock field driver: the first provider of the point seam, and
 * the acceptance vehicle for client development. It registers one simulated
 * connection whose points tick on a timer (bool toggles, int counts, float
 * sine wave, string timestamp); `offline: true` pushes `null` samples
 * instead. Writes echo back as samples.
 *
 * Points are addressed by the seam's (device, group, name) triple: device is
 * the connection id, names are unique within their group (default `main`),
 * so two instances never collide in the shared table; duplicate local names
 * fail config validation at load.
 *
 * @module @snap-rail/driver-mock
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the `ctx.points` /
// `ctx.connections` / `ctx.field` declaration merging alongside the runtime
// service.
import '@snap-rail/field'
import { z } from 'zod'
import {
  ConnectionId,
  type PointType,
  type PointValue,
} from '@snap-rail/field'

/** One mock tag: a group-scoped name plus its bus-semantic type. */
export interface MockPointConfig {
  name: string
  /** Group the tag lives in; the settings vocabulary's business section. */
  group: string
  type: PointType
}

/** Mock driver config: one connection, one point list, one cadence. */
export interface MockDriverConfig {
  connection: string
  title: string
  offline: boolean
  periodMs: number
  points: MockPointConfig[]
}

const driverSchema = z.object({
  connection: z.string().min(1).default('mock-1'),
  title: z.string().min(1).default('Mock connection'),
  offline: z.boolean().default(false),
  periodMs: z.number().int().min(10).default(1000),
  points: z.array(
    z.object({
      // Address parts reject `/` like every wire schema does — the mock is
      // a trust boundary too (config comes from plugins.yml), and the seam's
      // composite key stays unambiguous only if it never sees a slash.
      name: z.string().min(1).max(128).refine(
        value => !value.includes('/'), 'mock tag names must not contain "/"'),
      group: z.string().trim().min(1).max(128).refine(
        value => !value.includes('/'), 'mock group names must not contain "/"').default('main'),
      type: z.enum(['bool', 'int', 'float', 'string']),
    }),
  ).refine(
    points => new Set(points.map(point => `${point.group}/${point.name}`)).size === points.length,
    { message: 'mock tags must have unique group-scoped names' },
  ),
}) satisfies z.ZodType<MockDriverConfig>

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

/** The mock driver plugin. */
const mockDriverPlugin: Plugin.Object<MockDriverConfig> = {
  name: 'driver-mock',
  inject: ['points', 'connections', 'field', 'timer'],
  Config: driverSchema,
  apply(ctx: Context, config: MockDriverConfig): void {
    ctx.field.registerDriver(ctx, { id: 'mock', title: config.title })
    const connection = ConnectionId(config.connection)
    const registration = ctx.connections.register(ctx, {
      id: connection,
      driver: 'driver-mock',
      title: config.title,
    })
    registration.setPoints(config.points.map((point) => ({
      device: config.connection,
      group: point.group,
      name: point.name,
      connection,
      type: point.type,
    })))
    registration.setStatus(config.offline ? 'offline' : 'online')

    if (!config.offline) {
      registration.setWriteHandler((point, value) =>
        registration.sample({ device: point.device, group: point.group, name: point.name }, value))
    }

    const generators = new Map(config.points.map(point => [
      point,
      makeGenerator(point.type),
    ]))
    ctx.interval(() => {
      if (config.offline) {
        for (const point of generators.keys()) {
          registration.sample({ device: config.connection, group: point.group, name: point.name }, null)
        }
        return
      }
      for (const [point, next] of generators) {
        registration.sample({ device: config.connection, group: point.group, name: point.name }, next())
      }
    }, config.periodMs)
  },
}

export default mockDriverPlugin
