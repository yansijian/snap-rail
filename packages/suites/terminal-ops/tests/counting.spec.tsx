// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '@snap-rail/store'
import stationRpcPlugin from '@snap-rail/station-rpc'
import productionStatsPlugin from '../src/stats.ts'
import fieldPlugin, { type ConnectionRegistration } from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import timerPlugin from '../../../../vendor/timer/src/index.ts'
import type { HostChannel } from '@snap-rail/connection'
import { bootClient } from '@snap-rail/client-kernel'
import { createClientRuntime } from '@snap-rail/client-runtime'
import layoutPlugin from '../src/layout.tsx'
import maintenancePlugin from '../src/maintenance.tsx'
import productionPlugin from '../src/production.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A counting world: the station bridge over an in-process channel, the
 * host-side shift counter (store-backed, fast flush for the test), plus a
 * field rig whose connection provides the 产量计数 point the counter
 * follows.
 */
async function makeWorld(): Promise<{ channel: HostChannel, drive: (value: number | null) => void }> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-production-count-'))
  tempDirs.push(home)
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(storePlugin)
  await host.plugin(auditPlugin)
  await host.plugin(fieldPlugin)
  await host.plugin(fieldRpcPlugin)
  await host.plugin(timerPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent-plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)
  await host.plugin(productionStatsPlugin, { flushMs: 20 })

  let rig: ConnectionRegistration | undefined
  await host.plugin(Object.assign(
    function driver(sub: Context): void {
      rig = sub.connections.register(sub, { id: 'count-rig', driver: 'rig', title: 'Rig' })
      rig.setPoints([{ device: 'plc1', group: '产量', name: '产量计数', connection: 'count-rig' as never, type: 'int' }])
    },
    { inject: ['connections'] },
  ))

  return {
    channel: {
      invoke: request => host.rpc.handleClientRequest(request),
      openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
    },
    drive: value => {
      rig?.sample({ device: 'plc1', group: '产量', name: '产量计数' }, value === null ? null : BigInt(value))
    },
  }
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Sign on through the login card's embedded number pad (touch entry). */
async function loginAs(id: string): Promise<void> {
  for (const digit of id) {
    const key = document.querySelector<HTMLButtonElement>(`button[data-key="${digit}"]`)
    expect(key, `keypad key ${digit}`).not.toBeNull()
    key!.click()
    await flush(2)
  }
  const login = document.querySelector<HTMLButtonElement>('button[data-key="confirm"]')
  expect(login?.textContent).toContain('登录')
  login!.click()
  await flush(20)
}

/** The actual-output counter on the running production page. */
function actualValue(): number {
  return Number(document.querySelector<HTMLElement>('[data-value="actual"]')?.textContent ?? Number.NaN)
}

/** The shift a login right now would anchor to. */
function expectedShiftNow(): 'morning' | 'middle' | 'night' {
  const hour = new Date().getHours()
  if (hour >= 8 && hour < 16) return 'morning'
  if (hour >= 16) return 'middle'
  return 'night'
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('production actual counting', () => {
  it('declares the counting variable and accumulates positive deltas only', async () => {
    const { channel, drive } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin, maintenancePlugin, productionPlugin] })
    await flush()

    // The plugin declared its counting variable by its full address.
    expect(runtime.ctx.variables.list()).toContainEqual(
      expect.objectContaining({ device: 'plc1', group: '产量', name: '产量计数', type: 'int' }))

    // Gate chain: sign on, complete today's maintenance, start production.
    await loginAs('1001')
    const page = document.querySelector('[data-page="maintenance"]')!
    const pageButtons = (text: string): HTMLButtonElement[] =>
      [...page.querySelectorAll('button')].filter(button => button.textContent === text)
    for (const button of pageButtons('完成维护') as HTMLButtonElement[]) button.click()
    await flush()
    ;([...page.querySelectorAll('button')].find(button => button.textContent === '完成') as HTMLButtonElement).click()
    await flush(20)

    document.querySelector<HTMLButtonElement>('[data-workflow="production"]')!.click()
    await flush()
    // Model buttons carry "SR-100" plus the rate text; match by inclusion.
    ;([...document.querySelectorAll('button')].find(button => button.textContent?.includes('SR-100')) as HTMLButtonElement).click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent === '开始生产') as HTMLButtonElement).click()
    await flush(24)
    expect(document.querySelector('[data-value="actual"]')).not.toBeNull()

    // Seed, grow, reset, grow again — only positive deltas count.
    drive(0)
    await waitFor(() => actualValue() === 0, 'seed sample renders')
    drive(12)
    drive(20)
    await waitFor(() => actualValue() === 20, 'accumulates to 20')
    // Counter reset on the device: negative delta must not subtract.
    drive(5)
    drive(8)
    await waitFor(() => actualValue() === 23, 'reset ignored, +3 counted')
    // Abnormal round re-seeds: 30 only seeds, 35 adds 5.
    drive(null)
    drive(30)
    drive(35)
    await waitFor(() => actualValue() === 28, 're-seeded baseline adds 5')

    await runtime.dispose()
    element.remove()
  }, 25_000)

  it('keeps the count across page switches and still counts while the page is away', async () => {
    const { channel, drive } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin, maintenancePlugin, productionPlugin] })
    await flush()

    await loginAs('1001')
    const page = document.querySelector('[data-page="maintenance"]')!
    for (const button of [...page.querySelectorAll('button')].filter(button => button.textContent === '完成维护') as HTMLButtonElement[]) button.click()
    await flush()
    ;([...page.querySelectorAll('button')].find(button => button.textContent === '完成') as HTMLButtonElement).click()
    await flush(20)
    document.querySelector<HTMLButtonElement>('[data-workflow="production"]')!.click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent?.includes('SR-100')) as HTMLButtonElement).click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent === '开始生产') as HTMLButtonElement).click()
    await flush(24)

    drive(0)
    drive(20)
    await waitFor(() => actualValue() === 20, 'count 20 before leaving')

    // Leave the production page — the component unmounts.
    document.querySelector<HTMLButtonElement>('[data-workflow="maintenance"]')!.click()
    await flush()
    expect(document.querySelector('[data-page="production"]')).toBeNull()

    // The station keeps counting while nobody watches.
    drive(30)
    drive(45)

    // Come back: the count survived the round trip and includes the away
    // period's deltas.
    document.querySelector<HTMLButtonElement>('[data-workflow="production"]')!.click()
    await flush()
    expect(document.querySelector('[data-page="production"]')).not.toBeNull()
    await waitFor(() => actualValue() === 45, 'count includes the away period')

    await runtime.dispose()
    element.remove()
  }, 25_000)

  it('anchors the shift at login time and keeps the count across a re-login', async () => {
    const { channel, drive } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin, maintenancePlugin, productionPlugin] })
    await flush()

    await loginAs('1001')
    const expected = expectedShiftNow()
    const page = document.querySelector('[data-page="maintenance"]')!
    for (const button of [...page.querySelectorAll('button')].filter(button => button.textContent === '完成维护') as HTMLButtonElement[]) button.click()
    await flush()
    ;([...page.querySelectorAll('button')].find(button => button.textContent === '完成') as HTMLButtonElement).click()
    await flush(20)
    document.querySelector<HTMLButtonElement>('[data-workflow="production"]')!.click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent?.includes('SR-100')) as HTMLButtonElement).click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent === '开始生产') as HTMLButtonElement).click()
    await flush(24)

    drive(0)
    drive(7)
    await waitFor(() => actualValue() === 7, 'count 7')
    // The shift badge reflects the login-time window, and today's row
    // carries the live count under that shift.
    await waitFor(() => document.querySelector('[data-region="shift"] [data-shift]') !== null, 'shift badge')
    expect(document.querySelector('[data-region="shift"] [data-shift]')?.getAttribute('data-shift')).toBe(expected)
    await waitFor(() => {
      const cell = document.querySelector(`[data-region="shifts-today"] [data-shift-count="${expected}"]`)
      return cell?.textContent?.includes('7') ?? false
    }, 'today row shows the count')

    // Sign off and back on: the shift re-anchors (same window here) and the
    // count keeps going — a re-login never resets the shift's production.
    await runtime.ctx.session.logout()
    await flush(20)
    expect(document.querySelector('[data-cell="operator-id"]')).not.toBeNull()
    await loginAs('1001')
    await flush(20)
    if (document.querySelector('[data-page="production"]') === null) {
      document.querySelector<HTMLButtonElement>('[data-workflow="production"]')!.click()
      await flush()
    }
    await waitFor(() => actualValue() === 7, 'count survived the re-login')
    expect(document.querySelector('[data-region="shift"] [data-shift]')?.getAttribute('data-shift')).toBe(expected)
    drive(12)
    await waitFor(() => actualValue() === 12, 'counting continues after re-login')

    await runtime.dispose()
    element.remove()
  }, 25_000)
})
