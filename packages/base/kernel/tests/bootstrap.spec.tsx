// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { bootClient, droppedZipPath, showBootstrap, showStartup } from '../src/index.tsx'
import type { HostChannel } from '../src/index.tsx'
import type { PluginInfo } from '@snap-rail/app-boot/contract'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  document.body.innerHTML = ''
})

function inProcessChannel(ctx: Context): HostChannel {
  return {
    invoke: request => ctx.rpc.handleClientRequest(request),
    openStream: () => () => {},
  }
}

async function makeReady(): Promise<{ channel: HostChannel }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(gatewayPlugin, { name: 'demo-shell', version: '9.9.9', bin: 'desktop' })
  return { channel: inProcessChannel(ctx) }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const poolRow = (name: string, enabled: boolean, category?: string): PluginInfo => ({
  name,
  source: 'pool',
  enabled,
  packageName: name,
  ...(category !== undefined ? { category } : {}),
})

describe('the no-framework bootstrap page', () => {
  it('renders the drag hint with the close affordance, and closing returns to the startup page', async () => {
    const { channel } = await makeReady()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()

    showBootstrap(handle)
    await flush()
    expect(document.body.textContent).toContain('拖入 .zip 安装')
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')).not.toBeNull()

    // Closing returns to the connect page, which carries the corner entry
    // back into the install console.
    document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click()
    await flush()
    expect(document.body.textContent).not.toContain('拖入 .zip 安装')
    const reopen = document.querySelector<HTMLButtonElement>('button[aria-label="安装插件"]')
    expect(reopen).not.toBeNull()
    reopen!.click()
    await flush()
    expect(document.body.textContent).toContain('拖入 .zip 安装')

    handle.root.unmount()
    element.remove()
  })

  it('lists pool packages with enable toggles and restarts on demand; built-ins never list', async () => {
    const calls: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'bootstrap-test', version: '0.1.0', bin: 'test' })
    ctx.rpc.claimDomain(ctx, 'plugins')
    ctx.rpc.claimDomain(ctx, 'window')
    ctx.rpc.method(ctx, 'plugins.list', { request: z.object({}).strict() }, () => ({
      plugins: [
        poolRow('@snap-rail/framework-shadcn', false, '界面框架'),
        poolRow('@snap-rail/settings-station', true, '界面'),
        { name: '@snap-rail/settings', source: 'builtin', enabled: true, packageName: '@snap-rail/settings' } as PluginInfo,
      ],
    }))
    ctx.rpc.method(ctx, 'plugins.set-enabled', {
      request: z.object({ name: z.string(), enabled: z.boolean() }).strict(),
    }, ({ name }) => {
      calls.push(name)
      return { applied: true } as const
    })
    ctx.rpc.method(ctx, 'window.relaunch', { request: z.object({}).strict() }, () => {
      calls.push('window.relaunch')
      return { applied: true } as const
    })
    const channel = inProcessChannel(ctx)

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()
    showBootstrap(handle)
    await flush()

    // Both pool rows list with their author-named categories; the shipped
    // built-in row stays invisible (un-actionable rows are noise).
    expect(document.body.textContent).toContain('@snap-rail/framework-shadcn')
    expect(document.body.textContent).toContain('界面框架')
    expect(document.body.textContent).toContain('@snap-rail/settings-station')
    expect(document.body.textContent).not.toContain('@snap-rail/settings（')

    // Enabling a row goes through the wire and surfaces the restart seat.
    const toggles = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(toggles.length).toBe(2)
    expect(toggles[0]!.checked).toBe(false)
    toggles[0]!.click()
    await flush()
    expect(calls).toEqual(['@snap-rail/framework-shadcn'])
    const restartButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '重启生效')
    expect(restartButton).not.toBeNull()
    restartButton!.click()
    await flush()
    expect(calls).toContain('window.relaunch')

    handle.root.unmount()
    element.remove()
  })

  it('uninstalls an installed row and merges source catalog entries into the same list', async () => {
    const calls: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'bootstrap-test', version: '0.1.0', bin: 'test' })
    ctx.rpc.claimDomain(ctx, 'plugins')
    ctx.rpc.claimDomain(ctx, 'settings')
    let installed = [
      poolRow('@snap-rail/store-sqlite', true, '存储'),
    ]
    ctx.rpc.method(ctx, 'plugins.list', { request: z.object({}).strict() }, () => ({ plugins: installed }))
    ctx.rpc.method(ctx, 'settings.get', {
      request: z.object({ key: z.string() }).strict(),
    }, ({ key }) => ({ value: key === 'plugins.feedUrl' ? 'http://feed.example/plugins/' : null }))
    ctx.rpc.method(ctx, 'plugins.remote-list', { request: z.object({}).strict() }, () => ({
      plugins: [
        { name: '@snap-rail/store-sqlite', version: '0.1.0', action: 'current' },
        { name: '@snap-rail/framework-shadcn', version: '0.1.4', action: 'install' },
      ],
    }))
    ctx.rpc.method(ctx, 'plugins.uninstall', {
      request: z.object({ name: z.string() }).strict(),
    }, ({ name }) => {
      calls.push(`uninstall:${name}`)
      installed = []
      return { removed: true } as const
    })
    ctx.rpc.method(ctx, 'plugins.remote-install', {
      request: z.object({ name: z.string() }).strict(),
    }, ({ name }) => {
      calls.push(`remote-install:${name}`)
      installed = [poolRow('@snap-rail/framework-shadcn', false, '界面框架')]
      return { installed: { name, version: '0.1.4', updated: false } }
    })
    const channel = inProcessChannel(ctx)

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()
    showBootstrap(handle)
    await flush()

    // The installed row and the source-only entry share one list; the
    // installed+current entry shows the verdict badge without a button.
    expect(document.body.textContent).toContain('@snap-rail/store-sqlite')
    expect(document.body.textContent).toContain('已是最新')
    expect(document.body.textContent).toContain('@snap-rail/framework-shadcn')
    const uninstall = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '卸载')
    expect(uninstall).not.toBeNull()
    uninstall!.click()
    await flush()
    expect(calls).toContain('uninstall:@snap-rail/store-sqlite')

    // After the uninstall the source entry remains — now as a plain install.
    await flush()
    const install = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '安装')
    expect(install).not.toBeNull()
    install!.click()
    await flush()
    expect(calls).toContain('remote-install:@snap-rail/framework-shadcn')

    handle.root.unmount()
    element.remove()
  })

  it('the drop bridge returns null without a carrier (tests, non-Electron shells)', () => {
    expect(droppedZipPath({} as File)).toBeNull()
  })
})

describe('showStartup', () => {
  it('renders without the install corner when no callback rides along', async () => {
    const { channel } = await makeReady()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    showStartup(handle)
    await flush()
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="安装插件"]')).toBeNull()
    handle.root.unmount()
    element.remove()
  })
})
