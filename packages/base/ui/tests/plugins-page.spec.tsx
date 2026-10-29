// @vitest-environment happy-dom

/**
 * The built-in 插件管理 page's install pipeline: the entry point that the
 * 0cfbdea substrate rewrite dropped (install UI stayed only in the kernel
 * recovery page, invisible on a healthy boot). These tests fail if the
 * install section, the search→inspect→confirm→install flow, the
 * unverified-signature risk step, the feed-source editor, or the update
 * pill ever disappear from the normal-path page again.
 *
 * @module @snap-rail/ui/settings-pages/plugins.spec
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { InspectedArchive, PluginInfo } from '@snap-rail/app-boot/contract'
import { PLUGINS_FEED_URLS_KEY } from '@snap-rail/app-boot/contract'
import { PluginsPage } from '../src/settings-pages/plugins.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

/** A canned plugin archive: unverified signature drives the risk step. */
function inspectedPlugin(name = '@acme/widget'): InspectedArchive {
  return {
    kind: 'plugin',
    plugin: {
      name,
      version: '1.1.0',
      permissions: ['shell:notify'],
      hasClient: true,
      requires: [],
      signature: { state: 'unverified', keyId: 'acme-2026', reason: 'unknown-key' },
      missing: [],
      action: 'install',
    },
  }
}

function poolRow(name: string, version: string): PluginInfo {
  return {
    name,
    source: 'pool',
    enabled: true,
    packageName: name,
    kind: 'plugin',
    version,
    title: name,
    category: '其他',
  }
}

interface Call {
  method: string
  payload: unknown
}

/** A HostLink stub answering the plugins-domain methods the page calls. */
function fakeLink(handlers: Record<string, (payload: any) => unknown>): { link: HostLink, calls: Call[] } {
  const calls: Call[] = []
  const link = {
    call: vi.fn(async (method: string, payload?: unknown) => {
      calls.push({ method, payload })
      const handler = handlers[method]
      const value = handler === undefined ? {} : handler(payload)
      return { ok: true, value }
    }),
  }
  return { link: link as unknown as HostLink, calls }
}

function fakeCtx(link: HostLink): Context {
  return { client: { link } } as unknown as Context
}

async function mountPage(link: HostLink): Promise<void> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => {
    root.render(<PluginsPage ctx={fakeCtx(link)} />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(button => button.textContent?.includes(text))
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('内置插件管理页的安装管线', () => {
  it('正常路径下始终渲染安装入口（搜索/⚙ 源/拖拽区）', async () => {
    const { link } = fakeLink({})
    await mountPage(link)
    expect(document.querySelector('[data-plugins-dropzone]')).not.toBeNull()
    expect([...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === '配置插件源')).toBe(true)
    expect(buttonByText('搜索')).toBeDefined()
    expect(document.querySelector('input[placeholder*="粘贴"]')).not.toBeNull()
  })

  it('搜索→预览→未签名风险确认→安装，装完出现「重启生效」', async () => {
    const { link, calls } = fakeLink({
      'plugins.remote-list': () => ({
        plugins: [{
          name: '@acme/widget',
          version: '1.1.0',
          title: '示例插件',
          source: '官方源',
          feedUrl: 'https://feed.example/',
          file: '@acme__widget.zip',
          action: 'install',
        }],
      }),
      'plugins.inspect-from-url': () => ({ zipPath: 'C:/tmp/widget.zip', archive: inspectedPlugin() }),
    })
    await mountPage(link)

    const input = document.querySelector('input[placeholder*="粘贴"]') as HTMLInputElement
    await setInput(input, 'widget')
    await click(buttonByText('搜索')!)

    expect(calls.some(call => call.method === 'plugins.remote-list')).toBe(true)
    const install = buttonByText('安装')
    expect(install).toBeDefined()

    await click(install!)
    expect(calls.some(call => call.method === 'plugins.inspect-from-url')).toBe(true)
    expect(document.querySelector('[data-plugins-signature="unverified"]')).not.toBeNull()

    await click(document.querySelector('[data-plugins-install-confirm]')!)
    expect(document.querySelector('[data-plugins-risk]')).not.toBeNull()

    await click(document.querySelector('[data-plugins-risk-confirm]')!)
    expect(calls.some(call => call.method === 'plugins.install')).toBe(true)
    expect([...document.querySelectorAll('button')].some(button => button.textContent === '重启生效')).toBe(true)
  })

  it('⚙ 源面板：添加合法源并保存写入 settings，非法地址被拒', async () => {
    const { link, calls } = fakeLink({})
    await mountPage(link)

    await click([...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '配置插件源')!)
    const draft = document.querySelector('input[placeholder*="index.json"]') as HTMLInputElement
    await setInput(draft, 'ftp://bad.example')
    await click(buttonByText('添加源')!)
    expect(document.body.textContent).toContain('http(s)')

    await setInput(draft, 'https://feed.example/')
    await click(buttonByText('添加源')!)
    await click(document.querySelector('[data-plugins-feed-save]')!)

    const write = calls.find(call => call.method === 'settings.set')
    expect(write).toBeDefined()
    expect((write!.payload as { key: string }).key).toBe(PLUGINS_FEED_URLS_KEY)
    expect((write!.payload as { value: readonly string[] }).value).toEqual(['https://feed.example/'])
  })

  it('有待更新包时版本格显示更新 pill，点击直接走 remote-install', async () => {
    const { link, calls } = fakeLink({
      'plugins.list': () => ({ plugins: [poolRow('@acme/widget', '1.0.0')] }),
      'plugins.updates-check': () => ({
        updates: [{ name: '@acme/widget', installedVersion: '1.0.0', feedVersion: '1.1.0' }],
        feedUrls: [],
      }),
    })
    await mountPage(link)

    const pill = buttonByText('⟳ 1.1.0')
    expect(pill).toBeDefined()
    await click(pill!)
    expect(calls.some(call => call.method === 'plugins.remote-install')).toBe(true)
  })
})
