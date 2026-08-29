// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import titlebarPlugin from '../../chrome-titlebar/src/index.tsx'
import layoutPlugin from '../../layout-station/src/index.tsx'
import downtimePlugin from '../../process-downtime/src/index.tsx'
import faultPlugin from '../../process-fault/src/index.tsx'
import maintenancePlugin from '../../process-maintenance/src/index.tsx'
import productionPlugin from '../../process-production/src/index.tsx'
import samplingPlugin from '../../process-sampling/src/index.tsx'
import { bootClient } from '../../kernel/src/index.tsx'
import type { HostChannel } from '../../connection/src/index.tsx'
import { createClientRuntime } from '../src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    const home = ctx.get('snapRailHome') as string | undefined
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
  // A failed test leaves its element behind; never leak DOM into the next one.
  document.body.innerHTML = ''
})

/**
 * A station world: gateway + settings + audit + the station bridge over an
 * in-process channel. The pluginLayers stub carries an empty user layer.
 */
async function makeWorld(): Promise<HostChannel> {
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', mkdtempSync(join(tmpdir(), 'snap-rail-station-ui-')))
  await host.plugin(gatewayPlugin, { name: 'station-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent-plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)
  return {
    invoke: request => host.gateway.handleClientRequest(request),
    openStream: listener => host.gateway.attachDownlink(frame => listener(frame)),
  }
}

const ALL_OCCUPANTS = [
  layoutPlugin,
  titlebarPlugin,
  maintenancePlugin,
  productionPlugin,
  samplingPlugin,
  faultPlugin,
  downtimePlugin,
]

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

function workflowItem(id: string): HTMLElement | null {
  return document.querySelector(`[data-workflow="${id}"]`)
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

describe('station assembly', () => {
  it('shows the login page first and the workflow rail after sign-on', async () => {
    const channel = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: ALL_OCCUPANTS })
    await flush()

    // Before login: the login page, the titlebar, and no workflow rail.
    expect(document.querySelector('[data-region="login"]')).not.toBeNull()
    expect(document.querySelector('[data-region="workflow-list"]')).toBeNull()
    expect(document.body.textContent).toContain('snap-rail')

    await loginAs('1001')

    // After login: the rail with the operator, fault, and downtime unlocked.
    expect(document.querySelector('[data-region="login"]')).toBeNull()
    expect(document.querySelector('[data-region="workflow-list"]')).not.toBeNull()
    for (const id of ['maintenance', 'fault', 'downtime']) {
      expect(workflowItem(id)).not.toBeNull()
    }
    // The gated pair stays locked and gray until maintenance completes.
    expect(workflowItem('production')?.getAttribute('aria-disabled')).toBe('true')
    expect(workflowItem('sampling')?.getAttribute('aria-disabled')).toBe('true')
    // The maintenance page is the active content.
    expect(document.querySelector('[data-page="maintenance"]')).not.toBeNull()

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('unlocks production after the maintenance checklist completes', async () => {
    const channel = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: ALL_OCCUPANTS })
    await flush()

    await loginAs('1001')

    // Each item needs an explicit 完成维护/异常 choice before 完成 unlocks.
    const page = document.querySelector('[data-page="maintenance"]')!
    const pageButtons = (text: string): HTMLButtonElement[] =>
      [...page.querySelectorAll('button')].filter(button => button.textContent === text)
    expect(pageButtons('完成维护').length).toBe(5)
    const complete = (): HTMLButtonElement | undefined => pageButtons('完成')[0]
    expect(complete()?.disabled).toBe(true)

    // Four answers are not enough, and 异常 counts as an answer too.
    for (const button of pageButtons('完成维护').slice(0, 4)) button.click()
    await flush()
    expect(complete()?.disabled).toBe(true)
    pageButtons('异常').at(-1)!.click()
    await flush()
    expect(complete()?.disabled).toBe(false)
    complete()!.click()
    await flush(20)

    expect(document.body.textContent).toContain('今日自主维护已完成')
    expect(workflowItem('production')?.getAttribute('aria-disabled')).toBeNull()
    // Sampling stays locked until production starts today.
    expect(workflowItem('sampling')?.getAttribute('aria-disabled')).toBe('true')

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('asks for confirmation before the close window control fires', async () => {
    const sent: Array<{ method?: unknown, payload?: unknown }> = []
    const channel = await makeWorld()
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
    const runtime = await createClientRuntime(handle, { plugins: ALL_OCCUPANTS })
    await flush()

    const closeCalls = () => sent.filter(entry => entry.method === 'window.control' && (entry.payload as { action?: string })?.action === 'close')

    document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click()
    await flush()
    // The dialog intercepted the close; nothing reached the window yet.
    expect(document.body.textContent).toContain('退出客户端？')
    expect(closeCalls().length).toBe(0)

    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === '退出')
    expect(confirm).toBeDefined()
    confirm!.click()
    await flush()
    expect(closeCalls().length).toBe(1)

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
