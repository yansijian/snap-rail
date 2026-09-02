// @vitest-environment happy-dom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import titlebarPlugin from '../src/chrome.tsx'
import settingsStationPlugin from '@snap-rail/settings-station'
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
 * A counting world with the real settings service (settings.json lands in a
 * temp home) and the station bridge, plus a rig whose points give the picker
 * two devices to cascade through.
 */
async function makeWorld(): Promise<{
  channel: HostChannel
  home: string
  driveOld: (value: number | null) => void
  driveNew: (value: number | null) => void
}> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-production-settings-'))
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

  const OLD = { device: 'plc1', group: '产量', name: '产量计数' } as const
  const NEW = { device: 'plc2', group: '产量', name: '成品计数' } as const
  let rig: ConnectionRegistration | undefined
  await host.plugin(Object.assign(
    function driver(sub: Context): void {
      rig = sub.connections.register(sub, { id: 'count-rig', driver: 'rig', title: 'Rig' })
      rig.setPoints([
        { ...OLD, connection: 'count-rig' as never, type: 'int' },
        { device: 'plc1', group: '状态', name: '电机温度', connection: 'count-rig' as never, type: 'float' },
        { ...NEW, connection: 'count-rig' as never, type: 'int' },
      ])
    },
    { inject: ['connections'] },
  ))

  const drive = (ref: { device: string, group: string, name: string }, value: number | null): void => {
    rig?.sample(ref, value === null ? null : BigInt(value))
  }
  return {
    channel: {
      invoke: request => host.rpc.handleClientRequest(request),
      openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
    },
    home,
    driveOld: value => drive(OLD, value),
    driveNew: value => drive(NEW, value),
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

/** Pick one option of a TouchSelect: open the trigger, tap the option row. */
async function pickSelect(label: string, optionText: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[data-touch-select-trigger="${label}"]`)
  expect(trigger, `select trigger ${label}`).not.toBeNull()
  trigger!.click()
  await flush()
  const option = [...document.querySelectorAll('[data-option]')]
    .find(candidate => candidate.textContent?.includes(optionText))
  expect(option, `option ${optionText}`).toBeDefined()
  option!.click()
  await flush()
}

describe('production counting settings page', () => {
  it('picks the counting point in the settings dialog and hot-applies the rebind', async () => {
    const { channel, home, driveOld, driveNew } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, {
      plugins: [layoutPlugin, titlebarPlugin, settingsStationPlugin, maintenancePlugin, productionPlugin],
    })
    await flush()

    // The default binding declares the plc1 counting variable.
    expect(runtime.ctx.variables.list()).toContainEqual(
      expect.objectContaining({ device: 'plc1', group: '产量', name: '产量计数' }))

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
    ;([...document.querySelectorAll('button')].find(button => button.textContent?.includes('SR-100')) as HTMLButtonElement).click()
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent === '开始生产') as HTMLButtonElement).click()
    await flush(24)
    expect(document.querySelector('[data-value="actual"]')).not.toBeNull()

    // The 产量采集 page sorts into the settings dialog's menu.
    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()
    expect(document.querySelector('[data-settings-page="production"]')?.textContent).toContain('产量采集')
    document.querySelector<HTMLButtonElement>('[data-settings-page="production"]')!.click()
    await flush()
    await waitFor(() => document.querySelector('[data-region="production-count-page"]') !== null, 'counting page')
    const region = (): Element => document.querySelector('[data-region="production-count-page"]')!
    expect(region().textContent).toContain('当前绑定：plc1 / 产量 / 产量计数')

    // Cascade: picking plc2 narrows groups to 产量 and auto-picks its point.
    await pickSelect('绑定设备', 'plc2')
    const groupTrigger = document.querySelector<HTMLButtonElement>('button[data-touch-select-trigger="绑定分组"]')!
    expect(groupTrigger.textContent).toContain('产量')
    groupTrigger.click()
    await flush()
    const groupOptions = [...document.querySelectorAll('[data-option]')].map(option => option.textContent ?? '')
    expect(groupOptions).toEqual(['产量'])
    ;(document.querySelector('[data-option]') as HTMLElement).click()
    await flush()

    // The point select offers only plc2/产量's single member.
    const pointTrigger = document.querySelector<HTMLButtonElement>('button[data-touch-select-trigger="绑定点位"]')!
    expect(pointTrigger.textContent).toContain('成品计数')
    pointTrigger.click()
    await flush()
    const pointOptions = [...document.querySelectorAll('[data-option]')].map(option => option.textContent ?? '')
    expect(pointOptions.length).toBe(1)
    expect(pointOptions[0]).toContain('成品计数')
    ;(document.querySelector('[data-option]') as HTMLElement).click()
    await flush()

    // Saving writes settings.json and hot-applies through the change frame.
    const save = [...region().querySelectorAll('button')].find(button => button.textContent === '保存') as HTMLButtonElement
    save.click()
    await waitFor(() => region().querySelector('[data-cell="saved"]') !== null, 'saved note')
    await waitFor(() => {
      const addresses = runtime.ctx.variables.list().map(def => `${def.device}/${def.group}/${def.name}`)
      return addresses.includes('plc2/产量/成品计数') && !addresses.includes('plc1/产量/产量计数')
    }, 'variable redeclared at the new address')
    expect(region().textContent).toContain('当前绑定：plc2 / 产量 / 成品计数')

    // The running counter now follows the new point only — no restart, no
    // remount: the old address's frames no longer move it. Each drive
    // flushes so every sample renders separately (one batched render would
    // swallow the intermediate deltas the counter feeds on).
    const actual = (): number =>
      Number(document.querySelector<HTMLElement>('[data-value="actual"]')?.textContent ?? Number.NaN)
    driveNew(0)
    await flush(24)
    driveNew(12)
    await flush()
    driveNew(20)
    await waitFor(() => actual() === 20, 'new counter accumulates')
    driveOld(999)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(actual()).toBe(20)

    // The binding is durable in the project's settings.json.
    const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(stored['production.countBinding']).toEqual({ device: 'plc2', group: '产量', name: '成品计数' })

    await runtime.dispose()
    element.remove()
  }, 25_000)
})

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
