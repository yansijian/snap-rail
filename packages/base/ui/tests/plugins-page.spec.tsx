// @vitest-environment happy-dom

/**
 * The rebuilt 插件管理 page: the install pipeline lives behind the header
 * plus-entry in its own dialog whose whole surface is the drop target, the
 * list is one table with merged category cells, and the page carries no
 * mechanism copy. These tests fail if the entry, the
 * search→inspect→confirm→install flow, the unverified-signature risk step,
 * the update pill, or the merged-category table ever regress.
 *
 * @module @snap-rail/ui/settings-pages/plugins.spec
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { InspectedArchive, PluginInfo } from '@snap-rail/app-boot/contract'
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

function poolRow(name: string, version: string, category = '其他'): PluginInfo {
  return {
    name,
    source: 'pool',
    enabled: true,
    packageName: name,
    kind: 'plugin',
    version,
    title: name,
    category,
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

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label)
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
  it('页面无刷新按钮与内嵌安装区；加号入口打开安装弹框（输入/搜索/整体拖拽面）', async () => {
    const { link } = fakeLink({})
    await mountPage(link)

    expect(buttonByText('刷新')).toBeUndefined()
    expect(document.querySelector('[data-plugins-dropzone]')).toBeNull()
    expect(buttonByLabel('配置插件源')).toBeUndefined()

    const plus = buttonByLabel('安装插件')
    expect(plus).toBeDefined()
    await click(plus!)

    const panel = document.querySelector('[data-plugins-dropzone]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelector('input[placeholder^="本地路径"]')).not.toBeNull()
    expect([...panel!.querySelectorAll('button')].some(button => button.textContent === '搜索')).toBe(true)

    const hint = document.querySelector('[data-plugins-drop-hint]')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('拖入 .zip 安装')
    expect(hint!.closest('[data-snap-part="dialog.panel"]')).not.toBeNull()
  })

  it('弹框内搜索→预览→未签名风险确认→安装，装完出现「重启生效」', async () => {
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
    await click(buttonByLabel('安装插件')!)

    const input = document.querySelector('input[placeholder^="本地路径"]') as HTMLInputElement
    await setInput(input, 'widget')
    await click(buttonByText('搜索')!)

    expect(calls.some(call => call.method === 'plugins.remote-list')).toBe(true)
    const panel = document.querySelector('[data-plugins-dropzone]')!
    const install = [...panel.querySelectorAll('button')].find(button => button.textContent === '安装')
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

  it('列表是单一表格，分类列用 rowSpan 合并且同类相邻', async () => {
    const { link } = fakeLink({
      'plugins.list': () => ({
        plugins: [
          poolRow('@acme/store', '1.0.0', '存储'),
          poolRow('@acme/store2', '2.0.0', '存储'),
          poolRow('@acme/device', '3.0.0', '设备'),
        ],
      }),
    })
    await mountPage(link)

    const tables = document.querySelectorAll('table')
    expect(tables).toHaveLength(1)
    const merged = tables[0]!.querySelectorAll('td[rowspan]')
    expect(merged).toHaveLength(2)
    expect(merged[0]!.getAttribute('rowspan')).toBe('2')
    expect(merged[0]!.textContent).toBe('存储')
    expect(merged[1]!.getAttribute('rowspan')).toBe('1')
    expect(merged[1]!.textContent).toBe('设备')
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

  it('页面与弹框不出现机制说明词汇（plugins.yml / 渲染端 / 点击更新）', async () => {
    const { link } = fakeLink({
      'plugins.list': () => ({ plugins: [poolRow('@acme/widget', '1.0.0')] }),
    })
    await mountPage(link)
    await click(buttonByLabel('安装插件')!)

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('plugins.yml')
    expect(text).not.toContain('渲染端')
    expect(text).not.toContain('点击更新')
    expect(text).not.toContain('重启后生效')
  })
})
