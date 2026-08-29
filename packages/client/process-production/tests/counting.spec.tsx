// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import fieldPlugin, { type ConnectionRegistration } from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import { PointId } from '@snap-rail/protocol'
import timerPlugin from '../../../../vendor/timer/src/index.ts'
import type { HostChannel } from '../../connection/src/index.tsx'
import { bootClient } from '../../kernel/src/index.tsx'
import { createClientRuntime } from '../../runtime/src/index.tsx'
import layoutPlugin from '../../layout-station/src/index.tsx'
import maintenancePlugin from '../../process-maintenance/src/index.tsx'
import productionPlugin from '../src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A counting world: the station bridge over an in-process channel plus a
 * field rig whose connection provides the 产量计数 point the production
 * page follows.
 */
async function makeWorld(): Promise<{ channel: HostChannel, drive: (value: number | null) => void }> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-production-count-'))
  tempDirs.push(home)
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  await host.plugin(fieldPlugin)
  await host.plugin(fieldRpcPlugin)
  await host.plugin(timerPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent-plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)

  let rig: ConnectionRegistration | undefined
  await host.plugin(Object.assign(
    function driver(sub: Context): void {
      rig = sub.connections.register(sub, { id: 'count-rig', driver: 'rig', title: 'Rig' })
      rig.setPoints([{ id: PointId('产量计数'), connection: 'count-rig' as never, type: 'int' }])
    },
    { inject: ['connections'] },
  ))

  return {
    channel: {
      invoke: request => host.gateway.handleClientRequest(request),
      openStream: listener => host.gateway.attachDownlink(frame => listener(frame)),
    },
    drive: value => { rig?.sample(PointId('产量计数'), value === null ? null : BigInt(value)) },
  }
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Set a React controlled input's value the way React's tracker accepts. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function loginAs(id: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="工号"]')
  expect(input).not.toBeNull()
  setNativeValue(input!, id)
  await flush()
  const login = [...document.querySelectorAll('button')].find(button => button.textContent === '登录')
  expect(login).toBeDefined()
  login!.click()
  await flush(20)
}

/** The actual-output counter on the running production page. */
function actualValue(): number {
  return Number(document.querySelector<HTMLElement>('[data-value="actual"]')?.textContent ?? Number.NaN)
}

describe('production actual counting', () => {
  it('declares the counting variable and accumulates positive deltas only', async () => {
    const { channel, drive } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin, maintenancePlugin, productionPlugin] })
    await flush()

    // The plugin declared its counting variable for mapping surfaces.
    expect(runtime.ctx.variables.list().map(entry => entry.name)).toContain('产量计数')

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
    await flush()
    expect(actualValue()).toBe(0)
    drive(12)
    drive(20)
    await flush(24)
    expect(actualValue()).toBe(20)
    // Counter reset on the device: negative delta must not subtract.
    drive(5)
    await flush(24)
    expect(actualValue()).toBe(20)
    drive(8)
    await flush(24)
    expect(actualValue()).toBe(23)
    // Abnormal round re-seeds: 30 only seeds, 35 adds 5.
    drive(null)
    await flush(24)
    expect(actualValue()).toBe(23)
    drive(30)
    await flush(24)
    expect(actualValue()).toBe(23)
    drive(35)
    await flush(24)
    expect(actualValue()).toBe(28)

    await runtime.dispose()
    element.remove()
  }, 25_000)
})
