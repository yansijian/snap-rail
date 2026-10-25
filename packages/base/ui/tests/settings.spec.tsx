import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import slotsPlugin from '../src/slots.tsx'
import settingsPlugin from '../src/settings.tsx'
import { UI_SLOT_IDS } from '../src/contract.ts'

const contexts: Context[] = []

afterEach(async () => {
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
})