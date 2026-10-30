// @vitest-environment happy-dom

/**
 * The plugin feed-source editor dialog: hosted by the settings shell beside
 * its close control, the address input and its add action fill one row, a
 * bad address is refused in place, and saving writes the user's feed list
 * through the settings domain.
 *
 * @module @snap-rail/ui/settings-pages/plugin-feed.spec
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import { PLUGINS_FEED_URLS_KEY } from '@snap-rail/app-boot/contract'
import { PluginFeedDialog } from '../src/settings-pages/plugin-feed.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

interface Call {
  method: string
  payload: unknown
}

function fakeLink(handlers: Record<string, (payload: any) => unknown> = {}): { link: HostLink, calls: Call[] } {
  const calls: Call[] = []
  const link = {
    call: vi.fn(async (method: string, payload?: unknown) => {
      calls.push({ method, payload })
      const handler = handlers[method]
      const value = handler === undefined ? { value: null } : handler(payload)
      return { ok: true, value }
    }),
  }
  return { link: link as unknown as HostLink, calls }
}

async function mountDialog(link: HostLink): Promise<void> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const ctx = { client: { link } } as unknown as Context
  await act(async () => {
    root.render(<PluginFeedDialog ctx={ctx} open onOpenChange={() => {}} />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(button => button.textContent === text)
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

describe('插件源编辑弹框', () => {
  it('地址输入与添加按钮占满一行', async () => {
    const { link } = fakeLink()
    await mountDialog(link)

    const input = document.querySelector('input[placeholder="https://…"]') as HTMLInputElement
    expect(input).not.toBeNull()
    const shell = input.closest('[data-snap-part="input.root"]')
    expect(shell?.style.flexGrow).toBe('1')
    const row = [...document.querySelectorAll('div')].find(div =>
      div.style.width === '100%'
      && div.querySelector('input') !== null
      && [...div.querySelectorAll('button')].some(button => button.textContent === '添加源'))
    expect(row).not.toBeUndefined()
    expect(buttonByText('添加源')).toBeDefined()
  })

  it('非法地址就地拒绝，合法源添加后保存写入 settings', async () => {
    const { link, calls } = fakeLink()
    await mountDialog(link)

    const input = document.querySelector('input[placeholder="https://…"]') as HTMLInputElement
    await setInput(input, 'ftp://bad.example')
    await click(buttonByText('添加源')!)
    expect(document.body.textContent).toContain('http(s)')

    await setInput(input, 'https://feed.example/')
    await click(buttonByText('添加源')!)
    await click(document.querySelector('[data-plugins-feed-save]')!)

    const write = calls.find(call => call.method === 'settings.set')
    expect(write).toBeDefined()
    expect((write!.payload as { key: string }).key).toBe(PLUGINS_FEED_URLS_KEY)
    expect((write!.payload as { value: readonly string[] }).value).toEqual(['https://feed.example/'])
  })
})
