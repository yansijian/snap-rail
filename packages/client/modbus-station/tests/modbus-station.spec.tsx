// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '../../../store/store/src/index.ts'
import fieldPlugin from '../../../field/field/src/index.ts'
import fieldRpcPlugin from '../../../field/field/src/rpc.ts'
import timerPlugin from '../../../../vendor/timer/src/index.ts'
import driverPlugin from '../../../field/driver-modbus/src/index.ts'
import modbusRpcPlugin from '../../../field/driver-modbus/src/rpc.ts'
import { MODBUS_TABLES } from '../../../field/driver-modbus/src/tables.ts'
import { startFakePlc, type FakePlc } from '../../../field/driver-modbus/tests/fake-plc.ts'
import type { HostChannel } from '../../connection/src/index.ts'
import { bootClient } from '../../kernel/src/index.tsx'
import { createClientRuntime } from '../../runtime/src/index.tsx'
import layoutPlugin from '../../layout-station/src/index.tsx'
import titlebarPlugin from '../../chrome-titlebar/src/index.tsx'
import settingsStationPlugin from '../../settings-station/src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'
import modbusStationPlugin from '../src/index.tsx'

const contexts: Context[] = []
const tempDirs: string[] = []
const servers: Array<{ close: (cb: () => void) => void }> = []

afterEach(async () => {
  // Servers close before the host tree so in-flight reads land in the
  // driver's catch instead of racing teardown.
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))))
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
  await new Promise(resolve => setTimeout(resolve, 25))
})

async function makePlc(): Promise<FakePlc> {
  const plc = await startFakePlc(server => servers.push(server))
  // fc03 address 0..1 reads f32 = 40.5 exactly (0x42220000).
  plc.holding.set(0, 0x4222)
  plc.holding.set(1, 0x0000)
  return plc
}

const OCCUPANTS = [layoutPlugin, titlebarPlugin, settingsStationPlugin, modbusStationPlugin]

/** A demand plugin standing in for the first resident that listens to 炉温. */
const demandPlugin: Plugin.Object<void> = Object.assign(
  function demand(ctx: Context): void {
    ctx.variables.register(ctx, [{ name: '炉温', type: 'float', title: '炉温' }])
  },
  { inject: ['variables'] },
)

async function makeWorld(): Promise<HostChannel> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-modbus-ui-'))
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
  await host.plugin(driverPlugin)
  await host.plugin(modbusRpcPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent.yml'), rendererPackages: [] },
    setUserRow: async (): Promise<void> => {},
    recompose: (): unknown[] => [],
  } as never)
  return {
    invoke: request => host.gateway.handleClientRequest(request),
    openStream: listener => host.gateway.attachDownlink(frame => listener(frame)),
  }
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Pick one option of a Select primitive: click the trigger, click the option. */
async function pickSelect(ariaLabel: string, optionText: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${ariaLabel}"]`)
  expect(trigger, `select trigger ${ariaLabel}`).not.toBeNull()
  trigger!.click()
  await flush()
  const option = [...document.querySelectorAll('[role="option"]')]
    .find(candidate => candidate.textContent === optionText)
  expect(option, `option ${optionText}`).toBeDefined()
  option!.click()
  await flush()
}

describe('ModbusTCP settings page', () => {
  it('walks the acceptance path: open, add a debug var, map it, watch the value arrive', async () => {
    const plc = await makePlc()
    const channel = await makeWorld()

    // Seed one device row directly (as the rpc would have).
    const host = contexts[0]!
    const store = host.store.register(host, 'driver_modbus', MODBUS_TABLES)
    store.run(
      `INSERT INTO ${store.table('devices')} (id, title, host, port, unit_id, poll_ms, timeout_ms, enabled) `
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['plc1', '1号炉', '127.0.0.1', plc.port, 1, 100, 300, 1],
    )
    host.emit('modbus/config-changed')

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, {
      plugins: [...OCCUPANTS, { plugin: demandPlugin as Plugin }],
    })
    await flush()

    // Open settings from the titlebar gear; the ModbusTCP page sorts second.
    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()
    expect(document.querySelector('[data-settings-page="modbus"]')?.textContent).toContain('ModbusTCP')
    document.querySelector<HTMLButtonElement>('[data-settings-page="modbus"]')!.click()
    await flush()

    // The seeded device renders and comes online through the driver.
    await flush(40)
    const row = document.querySelector('[data-modbus-device-row="plc1"]')
    expect(row).not.toBeNull()
    await flush(80)
    expect(row!.textContent).toContain('在线')

    // The registry-declared variable appears with its plugin badge.
    expect(document.querySelector('[data-modbus-var-row="炉温"]')?.textContent).toContain('插件')

    // Declare a manual debug variable through the dialog.
    document.querySelector<HTMLButtonElement>('[data-testid="add-var"]')!.click()
    await flush()
    const nameInput = document.querySelector<HTMLInputElement>('[data-region="modbus-var-dialog"] input[aria-label="变量名"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(nameInput, '调试B')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const saveVar = [...document.querySelectorAll('[data-region="modbus-var-dialog"] button')]
      .find(button => button.textContent === '保存')!
    saveVar.click()
    await flush(24)
    expect(document.querySelector('[data-modbus-var-row="调试B"]')?.textContent).toContain('手动')

    // Map 炉温 onto plc1 fc03 address 0 and save; the live value arrives.
    const varRow = document.querySelector('[data-modbus-var-row="炉温"]')!
    await pickSelect('设备 炉温', '1号炉（plc1）')
    ;([...varRow.querySelectorAll('button')].find(button => button.textContent === '保存') as HTMLButtonElement).click()
    await flush(80)

    // Re-query each round: saving re-renders the row node.
    await waitFor(() => {
      const text = document.querySelector('[data-modbus-var-row="炉温"] [data-cell="value"]')?.textContent ?? ''
      return text !== '' && text !== '—' && text !== '异常'
    }, 'live value')
    const valueCell = document.querySelector('[data-modbus-var-row="炉温"] [data-cell="value"]')!
    // 0x42220000 decodes to exactly 40.5.
    expect(Number(valueCell.textContent)).toBe(40.5)

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
