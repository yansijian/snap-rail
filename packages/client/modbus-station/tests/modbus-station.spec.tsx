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

/** A demand plugin standing in for the first resident that listens to 炉温
 * — declared by its full device/group/name address. */
const demandPlugin: Plugin.Object<void> = Object.assign(
  function demand(ctx: Context): void {
    ctx.variables.register(ctx, [{ device: 'plc1', group: '温度', name: '炉温', type: 'float', title: '炉温' }])
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
    invoke: request => host.rpc.handleClientRequest(request),
    openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
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

/** Set an input's value the React way (native setter + bubbling input event). */
function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The dialog's right-most 保存 button. */
function saveButton(region: Element): HTMLButtonElement {
  const button = [...region.querySelectorAll('button')].find(candidate => candidate.textContent === '保存')
  expect(button, 'save button').toBeDefined()
  return button as HTMLButtonElement
}

describe('ModbusTCP settings page', () => {
  it('walks the acceptance path: device tabs, typed groups, points, and LEDs', async () => {
    const plc1 = await makePlc()
    const plc2 = await makePlc()
    const channel = await makeWorld()

    // Seed one device row directly (as the rpc would have).
    const host = contexts[0]!
    const store = host.store.register(host, 'driver_modbus', MODBUS_TABLES)
    store.run(
      `INSERT INTO ${store.table('devices')} (id, title, host, port, unit_id, poll_ms, timeout_ms, enabled) `
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['plc1', '1号炉', '127.0.0.1', plc1.port, 1, 100, 300, 1],
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

    // The device renders as a tab and its LED breathes green once connected.
    await waitFor(() => document.querySelector('[data-modbus-device-tab="plc1"]') !== null, 'device tab')
    await waitFor(() =>
      document.querySelector('[data-modbus-device-tab="plc1"] [data-tone="green"]') !== null, 'plc1 led green')

    // An empty device asks for its first group.
    expect(document.querySelector('[data-region="modbus-device-panel"]')?.textContent).toContain('还没有分组')

    // Create the fault group: bool, trims on save.
    document.querySelector<HTMLButtonElement>('[data-testid="add-group"]')!.click()
    await flush()
    const groupDialog = document.querySelector('[data-region="modbus-group-dialog"]')!
    setInput(groupDialog.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!, '故障报警')
    await flush()
    await pickSelect('分组数据类型', '开关 (bool)')
    saveButton(groupDialog).click()
    await flush(24)
    await waitFor(() => document.querySelector('[data-group-row="plc1:故障报警"]') !== null, 'fault group panel')
    const faultPanel = () => document.querySelector('[data-group-row="plc1:故障报警"]')!
    expect(faultPanel().textContent).toContain('开关 (bool)')
    expect(faultPanel().textContent).toContain('还没有点位')

    // Add the coil point inside it; the dialog locks device, group, and type.
    faultPanel().querySelector<HTMLButtonElement>('[data-testid="add-point"]')!.click()
    await flush()
    const pointDialog = document.querySelector('[data-region="modbus-point-dialog"]')!
    expect(pointDialog.textContent).toContain('开关 (bool)')
    setInput(pointDialog.querySelector<HTMLInputElement>('input[aria-label="点位名称"]')!, '主轴过载')
    await flush()
    await pickSelect('编码', '线圈')
    setInput(pointDialog.querySelector<HTMLInputElement>('input[aria-label="地址"]')!, '20')
    await flush()
    saveButton(pointDialog).click()
    await flush(24)
    await waitFor(() => document.querySelector('[data-modbus-var-row="主轴过载"]') !== null, 'fault point row')

    // The coil trips: the row shows the green true tag and the group LED
    // stays green (the value reads; a fault state is not a connection
    // failure).
    plc1.coils.set(20, true)
    await waitFor(() =>
      document.querySelector('[data-modbus-var-row="主轴过载"] [data-cell="value"]')?.textContent === 'true', 'coil value')
    // The bool renders as the green tag, not bare text.
    const valueTag = document.querySelector('[data-modbus-var-row="主轴过载"] [data-cell="value"] span')
    expect(valueTag?.className).toContain('bg-success')
    await waitFor(() => faultPanel().querySelector('[data-tone="green"]') !== null, 'fault group led green')

    // Row edit smoke: rows are read-only until 编辑; saving returns them.
    document.querySelector<HTMLButtonElement>('button[aria-label="编辑映射 主轴过载"]')!.click()
    await flush()
    const editRow = document.querySelector('[data-modbus-var-row="主轴过载"]')!
    expect(editRow.querySelector('input[aria-label="地址 主轴过载"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('button[aria-label="保存映射 主轴过载"]')!.click()
    await waitFor(() => {
      const row = document.querySelector('[data-modbus-var-row="主轴过载"]')
      return row !== null && row.querySelector('input[aria-label="地址 主轴过载"]') === null
    }, 'row back to read-only')
    await waitFor(() =>
      document.querySelector('[data-modbus-var-row="主轴过载"] [data-cell="value"]')?.textContent === 'true', 'value survives save')

    // Second group, float: the declared 炉温 maps in one dialog.
    document.querySelector<HTMLButtonElement>('[data-testid="add-group"]')!.click()
    await flush()
    const tempDialog = document.querySelector('[data-region="modbus-group-dialog"]')!
    setInput(tempDialog.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!, '温度')
    await flush()
    await pickSelect('分组数据类型', '小数 (float)')
    saveButton(tempDialog).click()
    await flush(24)
    await waitFor(() => document.querySelector('[data-group-row="plc1:温度"]') !== null, 'temp group panel')
    document.querySelector('[data-group-row="plc1:温度"]')!
      .querySelector<HTMLButtonElement>('[data-testid="add-point"]')!.click()
    await flush()
    const tempPoint = document.querySelector('[data-region="modbus-point-dialog"]')!
    expect(tempPoint.textContent).toContain('小数 (float)')
    // The group's declared-but-unmapped name is the datalist suggestion.
    expect(tempPoint.querySelector('datalist#modbus-unmapped-options option')?.getAttribute('value')).toBe('炉温')
    setInput(tempPoint.querySelector<HTMLInputElement>('input[aria-label="点位名称"]')!, '炉温')
    await flush()
    setInput(tempPoint.querySelector<HTMLInputElement>('input[aria-label="地址"]')!, '0')
    await flush()
    saveButton(tempPoint).click()
    await flush(24)

    // The plugin badge rides the row; 0x42220000 decodes to exactly 40.5.
    await waitFor(() => document.querySelector('[data-modbus-var-row="炉温"]') !== null, '炉温 row')
    expect(document.querySelector('[data-modbus-var-row="炉温"]')?.textContent).toContain('插件')
    await waitFor(() => {
      const text = document.querySelector('[data-modbus-var-row="炉温"] [data-cell="value"]')?.textContent ?? ''
      return text !== '' && text !== '—' && text !== '异常'
    }, 'live value')
    expect(Number(document.querySelector('[data-modbus-var-row="炉温"] [data-cell="value"]')!.textContent)).toBe(40.5)

    // The + button adds a second device: a new tab appears and activates.
    document.querySelector<HTMLButtonElement>('[data-testid="add-device"]')!.click()
    await flush()
    const deviceDialog = document.querySelector('[data-region="modbus-device-dialog"]')!
    setInput(deviceDialog.querySelector<HTMLInputElement>('input[aria-label="设备 ID"]')!, 'plc2')
    setInput(deviceDialog.querySelector<HTMLInputElement>('input[aria-label="设备名称"]')!, '2号炉')
    setInput(deviceDialog.querySelector<HTMLInputElement>('input[aria-label="IP 地址"]')!, '127.0.0.1')
    setInput(deviceDialog.querySelector<HTMLInputElement>('input[aria-label="端口"]')!, String(plc2.port))
    await flush()
    saveButton(deviceDialog).click()
    await flush(24)
    await waitFor(() => document.querySelector('[data-modbus-device-tab="plc2"]') !== null, 'plc2 tab')
    await waitFor(() => document.querySelector('[data-modbus-device-row="plc2"]') !== null, 'plc2 panel active')
    await waitFor(() =>
      document.querySelector('[data-modbus-device-tab="plc2"] [data-tone="green"]') !== null, 'plc2 led green')

    // Device descriptions edit smoke: read-only list → inline form → back.
    expect(document.querySelector('[data-modbus-device-row="plc2"] dl')?.textContent).toContain('abcd')
    document.querySelector<HTMLButtonElement>('button[aria-label="编辑设备 plc2"]')!.click()
    await flush()
    expect(document.querySelector('[data-modbus-device-row="plc2"] input[aria-label="设备名称"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('button[aria-label="保存设备 plc2"]')!.click()
    await waitFor(() =>
      document.querySelector('[data-modbus-device-row="plc2"] input[aria-label="设备名称"]') === null
      && document.querySelector('[data-modbus-device-row="plc2"] dl') !== null, 'device back to read-only')

    // Kill plc1's PLC: its tab LED goes red while plc2 stays green; the
    // group panels (mounted again by switching back) read all-red.
    const dead = servers.splice(0, 1)[0]!
    await new Promise<void>(resolve => dead.close(() => resolve()))
    await waitFor(() =>
      document.querySelector('[data-modbus-device-tab="plc1"] [data-tone="red"]') !== null, 'plc1 tab red')
    expect(document.querySelector('[data-modbus-device-tab="plc2"] [data-tone="green"]')).not.toBeNull()
    // Radix tab triggers activate on mousedown (not click), so dispatch one.
    document.querySelector<HTMLButtonElement>('[data-modbus-device-tab="plc1"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await flush()
    await waitFor(() =>
      document.querySelector('[data-group-row="plc1:故障报警"] [data-tone="red"]') !== null, 'fault group red')
    await waitFor(() =>
      document.querySelector('[data-group-row="plc1:温度"] [data-tone="red"]') !== null, 'temp group red')

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
