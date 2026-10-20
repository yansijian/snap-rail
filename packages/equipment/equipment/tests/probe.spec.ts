/**
 * The equipment seam's one-shot connection test: config validation, the
 * driver's probe outcome (expected failures are data), the missing-probe
 * error, and the base's hard timeout.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import storePlugin from '@snap-rail/store-sqlite'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import equipmentPlugin, { type DeviceProbeResult } from '../src/index.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
})

function driver(id: string, probe?: (config: Record<string, unknown>) => Promise<DeviceProbeResult>): (ctx: Context) => void {
  return Object.assign((ctx: Context): void => {
    ctx.equipment.registerDriver(ctx, {
      id,
      title: id,
      schemas: {
        device: z.object({ host: z.string().min(1) }).strict(),
        point: z.object({ type: z.enum(['bool', 'int', 'float', 'string']) }).strict(),
      },
      createConnection: () => ({ update: () => undefined, dispose: () => undefined }),
      ...(probe !== undefined ? { probe } : {}),
    })
  }, { inject: ['equipment'] })
}

async function makeEquipment(): Promise<Context> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-equipment-probe-'))
  const ctx = new Context()
  worlds.push({ ctx, home })
  ctx.provide('snapRailHome', home)
  await ctx.plugin(storePlugin)
  await ctx.plugin(equipmentPlugin)
  return ctx
}

describe('equipment connection test', () => {
  it('returns the driver probe outcome without persisting a device', async () => {
    const ctx = await makeEquipment()
    await ctx.plugin(driver('probe-rig', async config => config['host'] === 'bad'
      ? { ok: false, latencyMs: 2, error: { code: 'refused', message: '拒绝', hint: '检查端口' } }
      : { ok: true, latencyMs: 3, detail: '会话已建立', sample: { label: 'x', value: 42 } }))

    const ok = await ctx.equipment.testDevice({ driver: 'probe-rig', config: { host: 'ok' } })
    expect(ok).toEqual({ ok: true, latencyMs: 3, detail: '会话已建立', sample: { label: 'x', value: 42 } })

    const failed = await ctx.equipment.testDevice({ driver: 'probe-rig', config: { host: 'bad' } })
    expect(failed.ok).toBe(false)
    expect(failed.error?.code).toBe('refused')
    expect(ctx.equipment.config().devices).toHaveLength(0)
  })

  it('rejects an invalid config before touching the driver', async () => {
    const ctx = await makeEquipment()
    let called = false
    await ctx.plugin(driver('probe-rig', async () => {
      called = true
      return { ok: true, latencyMs: 1 }
    }))

    await expect(ctx.equipment.testDevice({ driver: 'probe-rig', config: { host: '' } }))
      .rejects.toMatchObject({ kind: 'invalid-config' })
    expect(called).toBe(false)
  })

  it('distinguishes unknown drivers from drivers without a probe', async () => {
    const ctx = await makeEquipment()
    await ctx.plugin(driver('no-probe'))

    await expect(ctx.equipment.testDevice({ driver: 'ghost', config: { host: 'x' } }))
      .rejects.toMatchObject({ kind: 'unknown-driver' })
    await expect(ctx.equipment.testDevice({ driver: 'no-probe', config: { host: 'x' } }))
      .rejects.toMatchObject({ kind: 'no-probe' })
  })

  it('bounds a hung probe with the base timeout', async () => {
    vi.useFakeTimers()
    const ctx = await makeEquipment()
    await ctx.plugin(driver('slow-rig', async () => new Promise(() => undefined)))

    const pending = ctx.equipment.testDevice({ driver: 'slow-rig', config: { host: 'x' } })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('timeout')
  })
})
