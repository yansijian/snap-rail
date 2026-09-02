// @vitest-environment happy-dom
/**
 * The unified 设备管理 page against the real modbus dialect: the point form
 * renders the union-of-literals 功能码 as a touch select that commits a
 * number, and the saved point round-trips through the base's validation.
 * (Regression: the anyOf-const projection once rendered as a text field and
 * committed "3" — every modbus point add was rejected by the driver schema.)
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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('设备管理 page over the modbus dialect', () => {
  it('saves a point whose fc commits as a number', async () => {
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
        subscribe: () => () => undefined,
      },
    })
    await client.plugin(fieldStationPlugin)

    const page = client.settingsPages.list().find(entry => entry.id === 'field')
    expect(page).toBeDefined()
    render(page!.render())

    await waitFor(() => expect(screen.getByRole('tab', { name: 'plc1' })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '加点' }))

    fireEvent.change(await screen.findByLabelText(/点位名称/), { target: { value: '产量1' } })

    // 功能码 is a union of number literals: a touch select committing 3 (number).
    fireEvent.click(document.querySelector('[data-touch-select-trigger="功能码"]')!)
    await waitFor(() => expect(document.querySelector('[data-option="3"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-option="3"]')!)

    // 地址 rides the numeric keyboard: 1, 0, 0, confirm.
    fireEvent.click(document.querySelector('[data-number-input="地址"]')!)
    for (const key of ['1', '0', '0']) fireEvent.click(document.querySelector(`[data-key="${key}"]`)!)
    fireEvent.click(document.querySelector('[data-key="confirm"]')!)

    fireEvent.click(document.querySelector('[data-touch-select-trigger="编码"]')!)
    await waitFor(() => expect(document.querySelector('[data-option="u16"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-option="u16"]')!)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(document.querySelector('[data-dialog-submit]')).toBeNull())

    expect(host.field.config().devices[0]?.groups[0]?.points).toEqual([
      { name: '产量1', config: { fc: 3, address: 100, encoding: 'u16', writable: false } },
    ])
  }, 20_000)
})
