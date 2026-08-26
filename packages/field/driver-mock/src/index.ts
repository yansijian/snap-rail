/**
 * The bundled mock field driver: the first provider of the point seam, and
 * the acceptance vehicle for client development. It registers one simulated
 * connection whose points tick on a timer (bool toggles, int counts,
 * float sine wave, string timestamp); `offline: true` pushes `null` samples
 * instead. Writes echo back as samples.
 *
 * Point ids are prefixed with the connection id (`<connection>.<tag>`), so
 * two instances never collide in the shared table; duplicate local tags fail
 * config validation at load.
 *
 * @module @snap-rail/driver-mock
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/cordis-plugin-timer'
// Consumer of the field seam: the import pulls in the `ctx.points` /
// `ctx.connections` declaration merging alongside the runtime service.
import '@snap-rail/field'
import { z } from 'zod'
import {
  ConnectionId,
  PointId,
  type PointDescriptor,
  type PointType,
  type PointValue,
} from '@snap-rail/protocol'

/** One mock tag: a local id plus its bus-semantic type. */
export interface MockPointConfig {
  id: string
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
      id: z.string().min(1),
      type: z.enum(['bool', 'int', 'float', 'string']),
    }),
  ).refine(
    points => new Set(points.map(point => point.id)).size === points.length,
    { message: 'mock tags must have unique ids' },
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
  inject: ['points', 'connections', 'timer'],
  Config: driverSchema,
  apply(ctx: Context, config: MockDriverConfig): void {
    const connection = ConnectionId(config.connection)
    const registration = ctx.connections.register(ctx, {
      id: connection,
      driver: 'driver-mock',
      title: config.title,
    })
    registration.setPoints(config.points.map((point): PointDescriptor => ({
      id: PointId(`${config.connection}.${point.id}`),
      connection,
      type: point.type,
    })))
    registration.setStatus(config.offline ? 'offline' : 'online')

    if (!config.offline) {
      registration.setWriteHandler((point, value) => registration.sample(point.id, value))
    }

    const generators = new Map(config.points.map(point => [
      PointId(`${config.connection}.${point.id}`),
      makeGenerator(point.type),
    ]))
    ctx.interval(() => {
      if (config.offline) {
        for (const id of generators.keys()) registration.sample(id, null)
        return
      }
      for (const [id, next] of generators) registration.sample(id, next())
    }, config.periodMs)
  },
}

export default mockDriverPlugin
