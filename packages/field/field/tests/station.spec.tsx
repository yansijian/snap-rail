// @vitest-environment happy-dom
/**
 * 设备管理 (the unified field settings page): device tabs over the base's
 * config tree, live values through the point subscription, and the create /
 * delete flows through the base's CRUD methods — all against a real host
 * world (gateway + store + field + bridge + rig driver) over an in-process
 * channel.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/client-settings'
import storePlugin from '@snap-rail/store'
import { z } from 'zod'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import fieldPlugin, { type DriverHandle } from '../src/index.ts'
import fieldRpcPlugin from '../src/rpc.ts'
import fieldStationPlugin from '../src/station.tsx'

const worlds: Array<{ ctx: Context, home: string }> = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose()
    rmSync(world.home, { recursive: true, force: true })
  }
  cleanup()
})

interface World {
  host: Context
  client: Context
  rig: DriverHandle | undefined
  open: () => void
}

async function makeWorld(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-field-station-'))
  const host = new Context()
  worlds.push({ ctx: host, home })
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station', version: '0.1.0', bin: 'test' })
  await host.plugin(auditPlugin)
  await host.plugin(storePlugin)
  await host.plugin(fieldPlugin)
  await host.plugin(fieldRpcPlugin)

  const world = { host, rig: undefined as DriverHandle | undefined } as { host: Context, rig: DriverHandle | undefined }
  await host.plugin(Object.assign(
    function rigDriver(sub: Context): void {
      sub.field.registerDriver(sub, {
        id: 'rig',
        title: 'Rig 驱动',
        schemas: {
          device: z.object({ rate: z.number().int().min(1).default(5).meta({ title: '速率' }) }).strict(),
          point: z.object({ type: z.enum(['bool', 'int', 'float', 'string']) }).strict(),
        },
        probe: async () => ({ ok: true, message: '探测成功' }),
        createConnection: (device, _points, handle) => {
          world.rig = handle
          return { update: () => undefined, dispose: () => undefined }
        },
      })
    },
    { inject: ['field'] },
  ))
  host.field.upsertDevice({ name: 'plc1', driver: 'rig', config: {} })
  host.field.upsertGroup('plc1', { name: '温度', type: 'float' })
  host.field.upsertPoint('plc1', '温度', { name: '温度1', config: {} })
  host.field.upsertPoint('plc1', '温度', { name: '温度2', config: {} })

  // The renderer tree: settings seam + this station face over a client link.
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

  return {
    host,
    client,
    rig: world.rig,
    open: () => {
      const page = client.settingsPages.list().find(entry => entry.id === 'field')
      expect(page).toBeDefined()
      render(page!.render())
    },
  }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('设备管理 page', () => {
  it('renders device tabs, group panels, and the point table', async () => {
    const world = await makeWorld()
    world.open()

    await waitFor(() => expect(screen.getByRole('tab', { name: 'plc1' })).not.toBeNull())
    expect(screen.getByText('温度')).not.toBeNull()
    expect(screen.getByText('温度1')).not.toBeNull()
    expect(screen.getByText('温度2')).not.toBeNull()
    await flush(2)
  })

  it('streams live values into the point cells', async () => {
    const world = await makeWorld()
    world.open()
    await waitFor(() => expect(screen.getByText('温度1')).not.toBeNull())

    world.rig?.sample({ device: 'plc1', group: '温度', name: '温度1' }, 21.5)
    await waitFor(() => expect(screen.queryAllByText('21.5').length).toBeGreaterThan(0))
    world.rig?.sample({ device: 'plc1', group: '温度', name: '温度2' }, null)
    await waitFor(() => expect(screen.getByText('异常')).not.toBeNull())
  })

  it('creates a device through the dialog: schema form, then the new tab', async () => {
    const world = await makeWorld()
    world.open()
    await waitFor(() => expect(screen.getByRole('tab', { name: '＋' })).not.toBeNull())

    // Radix tabs activate on mousedown (pointer), not click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: '＋' }), { button: 0 })
    const nameField = await screen.findByLabelText(/设备名称/)
    fireEvent.change(nameField, { target: { value: '2号炉' } })
    // The rig schema's default seeds the form; submit as-is.
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('tab', { name: '2号炉' })).not.toBeNull())
    const config = world.host.field.config()
    // Devices read back in id order (digits sort before letters).
    expect(config.devices.map(device => device.name)).toEqual(['2号炉', 'plc1'])
    await flush(2)
  })

  it('deletes a point through the confirm dialog', async () => {
    const world = await makeWorld()
    world.open()
    await waitFor(() => expect(screen.getByText('温度2')).not.toBeNull())

    const row = screen.getByText('温度2').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    const danger = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-confirm-danger]')
      expect(button).not.toBeNull()
      return button!
    })
    fireEvent.click(danger)

    await waitFor(() => expect(screen.queryByText('温度2')).toBeNull())
    expect(world.host.field.config().devices[0]?.groups[0]?.points.map(point => point.name)).toEqual(['温度1'])
    await flush(2)
  })

  it('runs the driver probe and shows the verdict', async () => {
    const world = await makeWorld()
    world.open()
    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(screen.getByText(/探测成功/)).not.toBeNull())
    await flush(2)
  })
})
