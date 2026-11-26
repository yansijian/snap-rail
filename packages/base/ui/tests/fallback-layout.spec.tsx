// @vitest-environment happy-dom

import { Context } from '@snap-rail/cordis'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { UiProvider } from '../src/slots.tsx'
import fallbackPlugin from '../src/fallback.tsx'
import { UI_SLOT_IDS } from '../src/contract.ts'
import pagesPlugin from '../src/pages.tsx'
import slotsPlugin from '../src/slots.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The built-in fallback layout is the only renderer most installations ever
 * use, so every slot it declares must actually be painted: a contribution to
 * a declared-but-unrendered slot would vanish without a trace. These tests
 * mount the real layout (real slot registry, real page registry, stubbed
 * settings/client services) and check each seat.
 */

const contexts: Context[] = []
const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A layout mounted on a real registry, with the app's page title behind it. */
async function makeLayout(): Promise<{ ctx: Context, render: () => Promise<HTMLElement> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(slotsPlugin)
  await ctx.plugin(pagesPlugin)
  // The layout only touches these from event handlers; the stub keeps the
  // mount honest without pulling the settings/client runtimes into the test.
  ctx.provide('settings', {
    open: () => {},
    close: () => {},
    toggle: () => {},
    isOpen: () => false,
    activePage: () => undefined,
    listPages: () => [],
    registerPage: () => () => {},
    subscribe: () => () => {},
    version: () => 0,
  })
  ctx.provide('client', { link: { call: async () => ({ ok: true, value: {} }) } } as never)
  ctx.pages.registerPage(ctx, { id: 'production', title: '生产信息', order: 0, render: () => <div>产量</div> })
  await ctx.plugin(fallbackPlugin)

  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const render = async (): Promise<HTMLElement> => {
    const layout = ctx.ui.activeLayout()
    if (layout === undefined) throw new Error('fallback layout did not register')
    await act(async () => {
      root.render(<UiProvider service={ctx.ui}>{layout.render()}</UiProvider>)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    return element
  }
  return { ctx, render }
}

/** Contribute into a slot and let the layout repaint. */
async function contribute(ctx: Context, slot: string, id: string, text: string): Promise<void> {
  await act(async () => {
    ctx.ui.contribute(ctx, slot, { id, order: 0, render: () => <span>{text}</span> })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('fallback layout slots', () => {
  it('paints the default window bar with the product and active page', async () => {
    const { render } = await makeLayout()
    const element = await render()
    expect(element.querySelector('.snap-fallback-titlebar')?.textContent).toContain('snap-rail · 生产信息')
    // Window controls stay with the layout unless a plugin replaces the bar.
    expect(element.querySelectorAll('button[aria-label]').length).toBeGreaterThanOrEqual(3)
    // Extension seats take no space until someone contributes.
    expect(element.querySelector('.snap-fallback-sidebar')).toBeNull()
    expect(element.querySelector('.snap-fallback-statusbar')).toBeNull()
  })

  it('paints titlebar action contributions inside the default bar', async () => {
    const { ctx, render } = await makeLayout()
    await render()
    await contribute(ctx, UI_SLOT_IDS.titlebarActions, 'sync', '同步中')
    const element = await render()
    const bar = element.querySelector('.snap-fallback-titlebar')
    expect(bar?.textContent).toContain('同步中')
    expect(bar?.textContent).toContain('snap-rail · 生产信息')
  })

  it('lets a titlebar occupant replace the whole bar', async () => {
    const { ctx, render } = await makeLayout()
    await contribute(ctx, UI_SLOT_IDS.titlebar, 'custom-bar', '自定义标题栏')
    const element = await render()
    expect(element.textContent).toContain('自定义标题栏')
    // The default bar (and its controls) are gone: the occupant owns them now.
    expect(element.querySelector('.snap-fallback-titlebar')).toBeNull()
  })

  it('paints sidebar and statusbar contributions in the shell frame', async () => {
    const { ctx, render } = await makeLayout()
    await contribute(ctx, UI_SLOT_IDS.sidebar, 'rail', '侧栏内容')
    await contribute(ctx, UI_SLOT_IDS.statusbar, 'clock', '08:00:00')
    const element = await render()
    expect(element.querySelector('.snap-fallback-sidebar')?.textContent).toContain('侧栏内容')
    expect(element.querySelector('.snap-fallback-statusbar')?.textContent).toContain('08:00:00')
  })
})
