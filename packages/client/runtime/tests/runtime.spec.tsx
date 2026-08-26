// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import fieldPlugin, { type ConnectionRegistration } from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import { ConnectionId, InProcessApiClient, PointId } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import titlebarPlugin from '../../chrome-titlebar/src/index.tsx'
import layoutPlugin from '../../layout-default/src/index.tsx'
import dashboardPlugin from '../../panel-dashboard/src/index.tsx'
import { bootClient } from '../../kernel/src/index.tsx'
import type { HostChannel } from '../../connection/src/index.tsx'
import { createClientRuntime } from '../src/index.tsx'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    const home = ctx.get('snapRailHome') as string | undefined
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

async function makeWorld(): Promise<{ channel: HostChannel, ctx: Context, drive: ConnectionRegistration }> {
  const host = new Context()
  contexts.push(host)
  ctxProvideHome(host)
  await host.plugin(gatewayPlugin, { name: 'demo-shell', version: '0.1.0', bin: 'desktop' })
  await host.plugin(auditPlugin)
  await host.plugin(fieldPlugin)
  // All four injected services of the bridge must exist, or the entry stays
  // suspended and silently registers nothing.
  await host.plugin(fieldRpcPlugin)

  let drive!: ConnectionRegistration
  await host.plugin(Object.assign(
    function rig(sub): void {
      drive = sub.connections.register(sub, { id: ConnectionId('conn-1'), driver: 'rig', title: 'Rig' })
      drive.setPoints([
        { id: PointId('conn-1.temp'), connection: ConnectionId('conn-1'), type: 'float' },
      ])
    },
    { inject: ['connections'] },
  ))

  const channel: HostChannel = {
    invoke: request => host.gateway.handleClientRequest(request),
    openStream: listener => host.gateway.attachDownlink(frame => listener(frame)),
  }
  return { channel, ctx: host, drive }
}

function ctxProvideHome(host: Context): void {
  host.provide('snapRailHome', mkdtempSync(join(tmpdir(), 'snap-rail-runtime-')))
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('createClientRuntime', () => {
  it('renders the full occupant stack and streams live point values', async () => {
    const { channel, drive } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)

    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, {
      plugins: [layoutPlugin, titlebarPlugin, dashboardPlugin],
    })

    // Let the dashboard's async bootstrap (list + wire subscribe) land before
    // driving values — a late joiner reads snapshot, then streams deltas.
    drive.setStatus('online')
    await flush()
    drive.sample(PointId('conn-1.temp'), 21.5)
    await flush()

    const text = document.body.textContent ?? ''
    expect(text).toContain('snap-rail')          // titlebar resident
    expect(text).toContain('conn-1.temp')        // dashboard card
    expect(text).toContain('21.5')               // streamed value
    expect(text).not.toContain('没有已加载的布局插件')

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('degrades to the notice when no layout plugin is present', async () => {
    const { channel } = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)

    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [] })
    await flush()

    expect(document.body.textContent).toContain('没有已加载的布局插件')
    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('sends window.control requests when a titlebar button is clicked', async () => {
    const sent: Array<{ method?: unknown, payload?: unknown }> = []
    const { channel, drive } = await makeWorld()
    const spyingChannel: HostChannel = {
      invoke: async request => {
        sent.push({ method: request.method, payload: request.payload })
        return channel.invoke(request)
      },
      openStream: channel.openStream,
    }

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel: spyingChannel })
    const runtime = await createClientRuntime(handle, {
      plugins: [layoutPlugin, titlebarPlugin, dashboardPlugin],
    })
    drive.setPoints([{ id: PointId('conn-1.temp'), connection: ConnectionId('conn-1'), type: 'float' }])
    await flush()

    const close = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '关闭')
    expect(close).toBeDefined()
    close?.click()
    await flush()

    expect(sent.some(entry => entry.method === 'window.control' && (entry.payload as { action?: string }).action === 'close')).toBe(true)

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
