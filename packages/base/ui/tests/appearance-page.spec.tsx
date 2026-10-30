// @vitest-environment happy-dom

/**
 * The rebuilt 外观与显示 page: the theme strip is one flat tab list — the
 * factory day/night pair first, then every loaded pool theme, then
 * installed-but-unloaded skin packages — with no mode section and no restart
 * copy. These tests fail if the mode tabs come back, if a loaded theme select
 * bypasses the settings row, or if an unloaded package skips the enable step.
 *
 * @module @snap-rail/ui/settings-pages/appearance.spec
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { PluginInfo } from '@snap-rail/app-boot/contract'
import { AppearancePage } from '../src/settings-pages/appearance.tsx'
import { ClientProvider } from '../src/runtime.tsx'
import skinsPlugin, { DEFAULT_DARK, DEFAULT_LIGHT_ID, SkinsProvider, type SkinsService } from '../src/skins.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface Call {
  method: string
  payload: unknown
}

/** A HostLink stub answering the methods the page calls. */
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

function skinRow(name: string, title: string, enabled: boolean): PluginInfo {
  return {
    name,
    source: 'pool',
    enabled,
    packageName: name,
    kind: 'skin',
    version: '1.0.0',
    title,
    category: '主题',
  }
}

/** Boot the real skin registry for the page to read. */
async function makeSkins(): Promise<{ ctx: Context; skins: SkinsService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(skinsPlugin)
  return { ctx, skins: ctx.skins }
}

/** Register a pool theme on the registry context under a package name. */
async function addTheme(ctx: Context, id: string, title: string): Promise<void> {
  await ctx.plugin({
    name: id,
    inject: ['skins'],
    apply(sub: { skins: Context['skins'] }): void {
      sub.skins.register(sub, { id, title, tokens: { ...DEFAULT_DARK.tokens } })
    },
  })
}

async function mountPage(link: HostLink, skins: SkinsService): Promise<void> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => {
    root.render(
      <ClientProvider service={{ link, surface: 'main' }}>
        <SkinsProvider service={skins}>
          <AppearancePage />
        </SkinsProvider>
      </ClientProvider>,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function tabByTitle(title: string): HTMLElement | undefined {
  return [...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === title)
}

async function click(tab: HTMLElement): Promise<void> {
  await act(async () => {
    // Radix tabs activate on mousedown, not click.
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('外观页的主题条', () => {
  it('is one flat strip: the factory pair only, with no mode section or restart copy', async () => {
    const { link } = fakeLink({})
    const { skins } = await makeSkins()
    await mountPage(link, skins)

    const tabs = [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)
    expect(tabs).toEqual(['钴蓝·白天', '钴蓝·黑夜'])
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('跟随系统')
    expect(text).not.toContain('主题模式')
    expect(text).not.toContain('界面皮肤')
    expect(text).not.toContain('更换皮肤后需要重启')
  })

  it('lists a loaded pool theme and selects it through the settings row alone', async () => {
    const { ctx, skins } = await makeSkins()
    await addTheme(ctx, '@acme/touch', '触感蓝')
    const { link, calls } = fakeLink({})
    await mountPage(link, skins)

    const tab = tabByTitle('触感蓝')
    expect(tab).toBeDefined()
    await click(tab!)

    const set = calls.find(item => item.method === 'settings.set')
    expect(set?.payload).toEqual({ key: 'ui.theme', value: { id: '@acme/touch' } })
    expect(calls.some(item => item.method === 'plugins.set-enabled')).toBe(false)
  })

  it('selecting an unloaded package enables it first, then writes the selection', async () => {
    const { skins } = await makeSkins()
    const { link, calls } = fakeLink({
      'plugins.list': () => ({ plugins: [skinRow('@acme/night', '极夜', false)] }),
    })
    await mountPage(link, skins)

    const tab = tabByTitle('极夜')
    expect(tab).toBeDefined()
    await click(tab!)

    const enable = calls.find(item => item.method === 'plugins.set-enabled')
    expect(enable?.payload).toEqual({ name: '@acme/night', enabled: true })
    const set = calls.find(item => item.method === 'settings.set')
    expect(set?.payload).toEqual({ key: 'ui.theme', value: { id: '@acme/night' } })
  })

  it('the active tab follows the theme registry', async () => {
    const { link } = fakeLink({})
    const { ctx, skins } = await makeSkins()
    await mountPage(link, skins)

    expect(tabByTitle('钴蓝·黑夜')?.getAttribute('data-state')).toBe('active')
    await act(async () => { ctx.skins.activate(DEFAULT_LIGHT_ID) })
    expect(tabByTitle('钴蓝·白天')?.getAttribute('data-state')).toBe('active')
  })
})
