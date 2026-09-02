// @vitest-environment happy-dom
/**
 * The unified 设备管理 page against the real modbus dialect: the point form
 * commits typed values (the union-of-literals 功能码 as a number), address
 * zero round-trips (an unset numeric field must never masquerade as 0), the
 * point table renders schema-derived dialect columns, and a driver
 * rejection arrives as readable issue text — never the bare `internal` the
 * duplicated-FieldError packaging bug once produced.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import timerPlugin from '@snap-rail/cordis-plugin-timer'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/client-settings'
import storePlugin from '@snap-rail/store'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin from '../../field/src/index.ts'
import fieldRpcPlugin from '../../field/src/rpc.ts'
import fieldStationPlugin from '../../field/src/station.tsx'
import modbusDriverPlugin from '../src/index.ts'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
  cleanup()
})

/** The host world (gateway→store→field→rpc→timer→modbus) plus its client. */
async function makeWorld(): Promise<Context> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-modbus-station-'))
  const host = new Context()
  worlds.push({ ctx: host, home })
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station', version: '0.1.0', bin: 'test' })
  await host.plugin(auditPlugin)
  await host.plugin(storePlugin)
  await host.plugin(fieldPlugin)
  await host.plugin(fieldRpcPlugin)
  await host.plugin(timerPlugin)
  await host.plugin(modbusDriverPlugin)
  host.field.upsertDevice({
    name: 'plc1',
    driver: 'modbus',
    config: { host: '127.0.0.1', port: 502, unitId: 1, pollMs: 500, timeoutMs: 250 },
  })
  host.field.upsertGroup('plc1', { name: '产量', type: 'int' })

  const client = new Context()
  worlds.push({ ctx: client, home: `${home}-client` })
  await client.plugin(settingsPlugin)
  let rpcSeq = 0
  client.provide('client', {
    link: {
      call: async (method: string, payload: unknown) => {
        rpcSeq += 1
        const response = await host.rpc.handleClientRequest(
          { type: 'client-request', rpcId: `s-${rpcSeq}`, method, payload } as never)
        return response.result
      },
      subscribe: (method: string, listener: (payload: unknown) => void) =>
        host.rpc.attachDownlink(frame => { if (frame.method === method) listener(frame.payload) }),
    },
  })
  await client.plugin(fieldStationPlugin)

  const page = client.settingsPages.list().find(entry => entry.id === 'field')
  expect(page).toBeDefined()
  render(page!.render())
  await waitFor(() => expect(screen.getByRole('tab', { name: 'plc1' })).not.toBeNull())
  return host
}

/** Open one add-point dialog and fill the name. */
async function openAddPoint(name: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '加点' }))
  fireEvent.change(await screen.findByLabelText(/点位名称/), { target: { value: name } })
}

/** Pick one TouchSelect option. */
async function pick(label: string, option: string): Promise<void> {
  fireEvent.click(document.querySelector(`[data-touch-select-trigger="${label}"]`)!)
  await waitFor(() => expect(document.querySelector(`[data-option="${option}"]`)).not.toBeNull())
  fireEvent.click(document.querySelector(`[data-option="${option}"]`)!)
}

/** Type digits into a numeric field and confirm. */
function typeDigits(label: string, keys: string[]): void {
  fireEvent.click(document.querySelector(`[data-number-input="${label}"]`)!)
  for (const key of keys) fireEvent.click(document.querySelector(`[data-key="${key}"]`)!)
  fireEvent.click(document.querySelector('[data-key="confirm"]')!)
}

describe('设备管理 page over the modbus dialect', () => {
  it('saves a typed point and renders the dialect columns', async () => {
    const host = await makeWorld()
    await openAddPoint('产量1')

    // The retired 缩放系数 field is gone from the form.
    expect(screen.queryByText('缩放系数')).toBeNull()

    await pick('功能码', '3')
    typeDigits('地址', ['1', '0', '0'])
    await pick('编码', 'u16')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(document.querySelector('[data-dialog-submit]')).toBeNull())

    expect(host.field.config().devices[0]?.groups[0]?.points).toEqual([
      { name: '产量1', config: { fc: 3, address: 100, encoding: 'u16', writable: false } },
    ])

    // The table carries the driver's own schema fields as columns.
    for (const header of ['功能码', '地址', '编码', '可写', '变化死区']) {
      expect(screen.getByRole('columnheader', { name: header })).not.toBeNull()
    }
    const row = screen.getByText('产量1').closest('tr')!
    expect(within(row).getByText('3')).not.toBeNull()
    expect(within(row).getByText('100')).not.toBeNull()
    expect(within(row).getByText('u16')).not.toBeNull()
    expect(within(row).getByText('否')).not.toBeNull()
    expect(within(row).getByText('—')).not.toBeNull() // deadband unset
  }, 20_000)

  it('saves address zero — an unset field shows a dash, never a fake 0', async () => {
    const host = await makeWorld()
    await openAddPoint('产量0')

    // The empty numeric field displays the unset dash, not a pretend 0.
    expect(document.querySelector('[data-number-input="地址"]')?.textContent).toBe('—')

    await pick('功能码', '3')
    typeDigits('地址', ['0'])
    await pick('编码', 'u16')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(document.querySelector('[data-dialog-submit]')).toBeNull())

    expect(host.field.config().devices[0]?.groups[0]?.points).toEqual([
      { name: '产量0', config: { fc: 3, address: 0, encoding: 'u16', writable: false } },
    ])
    const row = screen.getByText('产量0').closest('tr')!
    expect(within(row).getByText('0')).not.toBeNull()
  }, 20_000)

  it('shows the driver rejection as readable text, not bare internal', async () => {
    await makeWorld()
    await openAddPoint('产量x')

    // coil under an int group with fc 3: the refinement refuses.
    await pick('功能码', '3')
    typeDigits('地址', ['1'])
    await pick('编码', 'coil')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const error = await waitFor(() => {
      const line = document.querySelector('[data-dialog-error]')
      expect(line?.textContent).toBeTruthy()
      return line!.textContent!
    })
    expect(error).not.toBe('internal')
    expect(error).toContain('rejected by driver')
    // The dialog stays open for the operator to fix the combo.
    expect(document.querySelector('[data-dialog-submit]')).not.toBeNull()
  }, 20_000)
})
