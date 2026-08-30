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
import timerPlugin from '../../../../vendor/timer/src/index.ts'
import type { HostChannel } from '../../connection/src/index.tsx'
import { bootClient } from '../../kernel/src/index.tsx'
import { createClientRuntime } from '../../runtime/src/index.tsx'
import layoutPlugin from '../../layout-station/src/index.tsx'
import faultPlugin from '../src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A fault world: the station bridge over an in-process channel, a mapping
 * document provided by a test driver registered with the field seam (device
 * plc1 whose 故障报警 group holds 液压低压 and 主轴过载), and a field rig
 * providing those points.
 */
async function makeWorld(): Promise<{
  channel: HostChannel
  trip: (name: string, on: boolean) => void
}> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-fault-group-'))
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

  // The generic mapping view (dialect-free; member order is the projection's
  // choice — address order here, so the strip names 液压低压 first).
  const doc = {
    devices: [{ id: 'plc1', driver: 'rig' }],
    groups: [{ deviceId: 'plc1', name: '故障报警', type: 'bool' as const }],
    points: [
      { deviceId: 'plc1', group: '故障报警', name: '液压低压' },
      { deviceId: 'plc1', group: '故障报警', name: '主轴过载' },
    ],
  }

  let rig: ConnectionRegistration | undefined
  await host.plugin(Object.assign(
    function driver(sub: Context): void {
      sub.field.registerDriver(sub, { id: 'rig', title: 'Rig', mappings: () => doc })
      rig = sub.connections.register(sub, { id: 'plc1', driver: 'rig', title: 'Rig' })
      rig.setPoints(doc.points.map(point => ({
        device: point.deviceId, group: point.group, name: point.name, connection: 'plc1' as never, type: 'bool',
      })))
    },
    { inject: ['connections', 'field'] },
  ))

  return {
    channel: {
      invoke: request => host.rpc.handleClientRequest(request),
      openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
    },
    trip: (name, on) => { rig?.sample({ device: 'plc1', group: '故障报警', name }, on) },
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

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('fault page device-fault strip', () => {
  it('binds the configured group: strip and sidebar follow any member tripping', async () => {
    const { channel, trip } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, {
      plugins: [
        layoutPlugin,
        { plugin: faultPlugin, config: { faultBinding: { device: 'plc1', group: '故障报警' } } },
      ],
    })
    await flush()

    // Sign on; fault requires nothing, so its entry is the first unlocked page.
    const input = document.querySelector<HTMLInputElement>('input[aria-label="工号"]')
    expect(input).not.toBeNull()
    setNativeValue(input!, '1001')
    await flush()
    ;([...document.querySelectorAll('button')].find(button => button.textContent === '登录') as HTMLButtonElement).click()
    await flush(20)
    document.querySelector<HTMLButtonElement>('[data-workflow="fault"]')?.click()
    await flush()

    // The watcher resolves the group; both members never observed → normal.
    await waitFor(() => document.querySelector('[data-region="device-fault"]') !== null, 'strip renders')
    await waitFor(() => document.querySelector('[data-region="device-fault"]')?.getAttribute('data-state') === 'normal', 'strip normal')
    expect(document.querySelector('[data-workflow="fault"]')?.className).not.toContain('breathe')

    // One member trips: the strip names it and the sidebar breathes red.
    trip('主轴过载', true)
    await waitFor(() => document.querySelector('[data-region="device-fault"]')?.getAttribute('data-state') === 'fault', 'strip fault')
    expect(document.querySelector('[data-cell="device-fault-names"]')?.textContent).toBe('主轴过载')
    expect(document.querySelector('[data-workflow="fault"]')?.className).toContain('breathe')

    // The other trips too: address order names it first.
    trip('液压低压', true)
    await waitFor(() =>
      document.querySelector('[data-cell="device-fault-names"]')?.textContent === '液压低压、主轴过载', 'both names')

    // Both reset: the strip returns to normal and the alert clears.
    trip('主轴过载', false)
    trip('液压低压', false)
    await waitFor(() => document.querySelector('[data-region="device-fault"]')?.getAttribute('data-state') === 'normal', 'strip back to normal')
    expect(document.querySelector('[data-workflow="fault"]')?.className).not.toContain('breathe')

    // A human report still breathes red with the group healthy.
    document.querySelector<HTMLButtonElement>('button[aria-label="故障提报"]')!.click()
    await flush(24)
    expect(document.querySelector('[data-workflow="fault"]')?.className).toContain('breathe')
    expect(document.querySelector('[data-region="device-fault"]')?.getAttribute('data-state')).toBe('normal')

    await runtime.dispose()
    element.remove()
  }, 25_000)
})
