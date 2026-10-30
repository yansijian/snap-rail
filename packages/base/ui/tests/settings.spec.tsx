// @vitest-environment happy-dom

import { Context } from '@snap-rail/cordis'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostLink } from '@snap-rail/connection'
import slotsPlugin from '../src/slots.tsx'
import settingsPlugin, { SettingsSurface } from '../src/settings.tsx'
import { UI_SLOT_IDS } from '../src/contract.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const contexts: Context[] = []
const roots: Root[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeSettings(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(slotsPlugin)
  await ctx.plugin(settingsPlugin)
  return ctx
}

function page(ctx: Context, id: string, order: number, group = '系统'): void {
  ctx.settings.registerPage(ctx, { id, title: id, group, order, render: () => id })
}

describe('ctx.settings', () => {
  it('registers pages in order and exposes the first page when opened', async () => {
    const ctx = await makeSettings()
    page(ctx, 'equipment', 20, '设备')
    page(ctx, 'plugins', 0)
    ctx.settings.open()
    expect(ctx.settings.listPages().map(item => item.id)).toEqual(['plugins', 'appearance', 'equipment'])
    expect(ctx.settings.activePage()).toBe('plugins')
  })

  it('opens a requested page and falls back to the first when it disappears', async () => {
    const ctx = await makeSettings()
    page(ctx, 'plugins', 0)
    page(ctx, 'equipment', 10)
    ctx.settings.open('equipment')
    expect(ctx.settings.activePage()).toBe('equipment')
    ctx.settings.close()
    expect(ctx.settings.isOpen()).toBe(false)
    expect(ctx.settings.activePage()).toBeUndefined()
  })

  it('drops pages when their registering fiber unloads', async () => {
    const ctx = await makeSettings()
    page(ctx, 'plugins', 0)
    const fiber = await ctx.plugin(Object.assign(
      function equipment(sub): void {
        sub.settings.registerPage(sub, { id: 'equipment', title: '设备', order: 10, render: () => 'equipment' })
      },
      { inject: ['settings'] },
    ))
    ctx.settings.open()
    expect(ctx.settings.listPages()).toHaveLength(3)
    await fiber.dispose()
    expect(ctx.settings.listPages().map(item => item.id)).toEqual(['plugins', 'appearance'])
  })

  it('registers a default trigger and surface through the region slots', async () => {
    const ctx = await makeSettings()
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.id)).toEqual(['settings.default-entry'])
    expect(ctx.ui.list(UI_SLOT_IDS.settingsSurface).map(item => item.id)).toEqual(['settings.default-surface'])
  })

  it('lets a higher-precedence trigger replace the default', async () => {
    const ctx = await makeSettings()
    const fiber = await ctx.plugin(Object.assign(
      function customEntry(sub): void {
        sub.ui.contribute(sub, UI_SLOT_IDS.settingsEntry, {
          id: 'custom-entry',
          order: 0,
          precedence: 10,
          render: () => 'custom',
        })
      },
      { inject: ['ui'] },
    ))
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.id)).toEqual(['custom-entry'])
    await fiber.dispose()
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.id)).toEqual(['settings.default-entry'])
  })

  it('surface header hosts the feed entry beside the icon close', async () => {
    const ctx = await makeSettings()
    const link: HostLink = {
      call: async () => ({ ok: false, error: { code: 'internal', details: { what: 'stub' } } }),
    } as unknown as HostLink
    ctx.provide('client', { link, surface: 'main' })
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => {
      root.render(<SettingsSurface service={ctx.settings} ctx={ctx} />)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => {
      ctx.settings.open()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.querySelector('button[aria-label="关闭"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="配置插件源"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('关闭')
  })
})