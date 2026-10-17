// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import { fireEvent } from '@testing-library/react'
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
        poolRow('@snap-rail/equipment-station', true, '界面'),
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
    expect(document.body.textContent).toContain('@snap-rail/equipment-station')
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

  it('uninstalls on the second tap, searches the feed, and installs through the address pipeline', async () => {
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
    }, ({ key }) => ({ value: key === 'plugins.feedUrls' ? ['http://feed.example/plugins/'] : null }))
    ctx.rpc.method(ctx, 'plugins.updates-check', { request: z.object({}).strict() }, () => ({ updates: [] }))
    ctx.rpc.method(ctx, 'plugins.remote-list', { request: z.object({}).strict() }, () => ({
      plugins: [
        { name: '@snap-rail/store-sqlite', version: '0.1.0', action: 'current', source: 'feed.example' },
        {
          name: '@snap-rail/framework-shadcn', version: '0.1.4', file: '@snap-rail__framework-shadcn.zip',
          action: 'install', source: 'feed.example', feedUrl: 'http://feed.example/plugins/',
        },
      ],
      feedUrls: ['http://feed.example/plugins/'],
    }))
    ctx.rpc.method(ctx, 'plugins.uninstall', {
      request: z.object({ name: z.string() }).strict(),
    }, ({ name }) => {
      calls.push(`uninstall:${name}`)
      installed = []
      return { removed: true } as const
    })
    ctx.rpc.method(ctx, 'plugins.inspect-from-url', {
      request: z.object({ url: z.string() }).strict(),
    }, ({ url }) => {
      calls.push(`inspect-from-url:${url}`)
      return {
        archive: {
          kind: 'plugin' as const,
          plugin: {
            name: '@snap-rail/framework-shadcn', version: '0.1.4', permissions: [], hasClient: true,
            requires: [], missing: [], action: 'install' as const,
            signature: { state: 'unverified', reason: 'unsigned' } as const,
          },
        },
        zipPath: `temp-${url.split('/').pop()}`,
      }
    })
    ctx.rpc.method(ctx, 'plugins.install', {
      request: z.object({ zipPath: z.string() }).strict(),
    }, ({ zipPath }) => {
      calls.push(`install:${zipPath}`)
      installed = [poolRow('@snap-rail/framework-shadcn', false, '界面框架')]
      return { installed: { name: '@snap-rail/framework-shadcn', version: '0.1.4', updated: false } }
    })
    const channel = inProcessChannel(ctx)

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()
    showBootstrap(handle)
    await flush()

    // The installed row lists; the uninstall button arms on the first tap
    // (确认卸载) and only the second tap goes through the wire.
    expect(document.body.textContent).toContain('@snap-rail/store-sqlite')
    const uninstall = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '卸载')!
    uninstall.click()
    await flush()
    expect(calls).toEqual([])
    const armed = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '确认卸载')!
    armed.click()
    await flush()
    expect(calls).toContain('uninstall:@snap-rail/store-sqlite')

    // Non-address text searches the feed: the result row carries the entry
    // and its source; the 安装 previews through the address pipeline (the
    // entry's own feed base + file).
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="粘贴本地/网络地址"]')!
    fireEvent.change(input, { target: { value: 'framework' } })
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '搜索')!.click()
    await flush()
    expect(document.body.textContent).toContain('@snap-rail/framework-shadcn')
    expect(document.body.textContent).toContain('feed.example')
    const install = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '安装')!
    install.click()
    await flush()
    expect(calls).toContain('inspect-from-url:http://feed.example/plugins/@snap-rail__framework-shadcn.zip')

    // The preview shows the unverified signature; the confirm routes through
    // the explicit risk step before the install consumes the temp path.
    expect(document.querySelector('[data-bootstrap-signature="unverified"]')).not.toBeNull()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '安装' && button.disabled === false)!
    confirm.click()
    await flush()
    expect(calls).not.toContain('install:temp-@snap-rail__framework-shadcn.zip')
    expect(document.querySelector('[data-bootstrap-risk]')).not.toBeNull()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '我知晓风险，仍要安装')!.click()
    await flush()
    expect(calls).toContain('install:temp-@snap-rail__framework-shadcn.zip')
    expect(document.body.textContent).toContain('@snap-rail/framework-shadcn')

    handle.root.unmount()
    element.remove()
  })

  it('confirms a key-changed update before it installs', async () => {
    const calls: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'bootstrap-test', version: '0.1.0', bin: 'test' })
    ctx.rpc.claimDomain(ctx, 'plugins')
    ctx.rpc.claimDomain(ctx, 'settings')
    let installed = [poolRow('@author/pkg', true)]
    ctx.rpc.method(ctx, 'plugins.list', { request: z.object({}).strict() }, () => ({ plugins: installed }))
    ctx.rpc.method(ctx, 'settings.get', { request: z.object({ key: z.string() }).strict() }, () => ({ value: null }))
    ctx.rpc.method(ctx, 'plugins.updates-check', { request: z.object({}).strict() }, () => ({
      updates: [{ name: '@author/pkg', installedVersion: '1.0.0', feedVersion: '2.0.0', keyChanged: true }],
    }))
    ctx.rpc.method(ctx, 'plugins.remote-install', {
      request: z.object({ name: z.string() }).strict(),
    }, ({ name }) => {
      calls.push(`remote-install:${name}`)
      installed = [poolRow('@author/pkg', true)]
      return { installed: { name, version: '2.0.0', updated: true } }
    })
    const channel = inProcessChannel(ctx)

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()
    showBootstrap(handle)
    await flush()

    // The pill click stops at the key-change card; only the explicit
    // 仍要更新 fires the install.
    expect(document.body.textContent).toContain('⟳ 2.0.0')
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '⟳ 2.0.0')!.click()
    await flush()
    expect(calls).toEqual([])
    expect(document.body.textContent).toContain('发布者密钥已变更')
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '仍要更新')!.click()
    await flush()
    expect(calls).toEqual(['remote-install:@author/pkg'])

    handle.root.unmount()
    element.remove()
  })

  it('previews a combo archive and installs it through install-combo', async () => {
    const calls: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'bootstrap-test', version: '0.1.0', bin: 'test' })
    ctx.rpc.claimDomain(ctx, 'plugins')
    ctx.rpc.claimDomain(ctx, 'settings')
    ctx.rpc.method(ctx, 'plugins.list', { request: z.object({}).strict() }, () => ({ plugins: [] }))
    ctx.rpc.method(ctx, 'settings.get', { request: z.object({ key: z.string() }).strict() }, () => ({ value: null }))
    ctx.rpc.method(ctx, 'plugins.updates-check', { request: z.object({}).strict() }, () => ({ updates: [] }))
    ctx.rpc.method(ctx, 'plugins.inspect', {
      request: z.object({ zipPath: z.string() }).strict(),
    }, ({ zipPath }) => {
      calls.push(`inspect:${zipPath}`)
      return {
        archive: {
          kind: 'combo' as const,
          combo: {
            id: 'demo-base', version: '1.0.0', title: '演示基座', kind: 'base' as const,
            plugins: [
              {
                name: '@scope/a', version: '1.0.0', permissions: [], hasClient: false,
                signature: { state: 'verified', keyId: 'k', publisher: 'snap-rail' } as const,
                action: 'install' as const,
              },
              {
                name: '@scope/b', version: '2.0.0', permissions: [], hasClient: true,
                signature: { state: 'unverified', reason: 'unsigned' } as const,
                action: 'update' as const, installed: { version: '1.0.0' },
              },
            ],
            missing: [], hasClient: true,
          },
        },
      }
    })
    ctx.rpc.method(ctx, 'plugins.install-combo', {
      request: z.object({ zipPath: z.string() }).strict(),
    }, ({ zipPath }) => {
      calls.push(`install-combo:${zipPath}`)
      return {
        installed: [
          { name: '@scope/a', version: '1.0.0', updated: false },
          { name: '@scope/b', version: '2.0.0', updated: true },
        ],
        preset: 'recipe-demo-base.yml',
      }
    })
    const channel = inProcessChannel(ctx)

    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()
    showBootstrap(handle)
    await flush()

    const input = document.querySelector<HTMLInputElement>('input[placeholder^="粘贴本地/网络地址"]')!
    fireEvent.change(input, { target: { value: 'C:\\tmp\\demo-base.zip' } })
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '搜索')!.click()
    await flush()
    expect(calls).toContain('inspect:C:\\tmp\\demo-base.zip')
    expect(document.body.textContent).toContain('安装组合套件')
    expect(document.body.textContent).toContain('演示基座')
    expect(document.body.textContent).toContain('@scope/b 2.0.0')
    expect(document.body.textContent).toContain('⚠ 未验证')

    // One unverified member routes through the combo risk card; only the
    // explicit acknowledgement fires install-combo.
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '安装组合')!.click()
    await flush()
    expect(calls).not.toContain('install-combo:C:\\tmp\\demo-base.zip')
    expect(document.querySelector('[data-bootstrap-risk]')).not.toBeNull()
    expect(document.body.textContent).toContain('此组合含未经发布者验证的插件')
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '我知晓风险，仍要安装')!.click()
    await flush()
    expect(calls).toContain('install-combo:C:\\tmp\\demo-base.zip')

    handle.root.unmount()
    element.remove()
  })

  it('the drop bridge returns null without a carrier (tests, non-Electron shells)', () => {
    expect(droppedZipPath({} as File)).toBeNull()
  })

  it('surfaces the crash notice as the red anomaly strip', async () => {
    const { channel } = await makeReady()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    await flush()

    showBootstrap(handle, { notice: '插件异常：界面框架启动失败\nboom' })
    await flush()
    const strip = document.querySelector('[data-bootstrap-notice]')
    expect(strip).not.toBeNull()
    expect(strip!.textContent).toContain('插件异常：界面框架启动失败')
    expect(strip!.textContent).toContain('boom')

    handle.root.unmount()
    element.remove()
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
