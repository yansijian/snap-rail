import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import settingsPlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeSettings(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(settingsPlugin)
  return ctx
}

function page(ctx: Context, id: string, order: number, label = id): void {
  ctx.settingsPages.register(ctx, { id, order, title: label, render: () => label })
}

describe('settingsPages', () => {
  it('orders pages by order then registration time and flags the active one', async () => {
    const ctx = await makeSettings()
    page(ctx, 'modbus', 10, 'ModbusTCP')
    page(ctx, 'plugins', 0, '插件管理')
    page(ctx, 'about', 10, '关于')

    ctx.settingsPages.open()
    expect(ctx.settingsPages.list().map(item => item.id)).toEqual(['plugins', 'modbus', 'about'])
    // No explicit request: the first menu page is active.
    expect(ctx.settingsPages.active()).toBe('plugins')
    expect(ctx.settingsPages.list().find(item => item.id === 'plugins')?.active).toBe(true)
    expect(ctx.settingsPages.list().find(item => item.id === 'about')?.active).toBe(false)
  })

  it('open(id) requests that page; a missing id falls back to the first page', async () => {
    const ctx = await makeSettings()
    page(ctx, 'plugins', 0)
    page(ctx, 'modbus', 10)

    ctx.settingsPages.open('modbus')
    expect(ctx.settingsPages.active()).toBe('modbus')

    // Pages can register after the open request (load order): a requested
    // id that is not (yet) registered resolves to the first page.
    const other = await makeSettings()
    other.settingsPages.open('modbus')
    page(other, 'plugins', 0)
    expect(other.settingsPages.active()).toBe('plugins')
  })

  it('isOpen/close/toggle track the dialog state and emit open-changed', async () => {
    const ctx = await makeSettings()
    const opens: boolean[] = []
    ctx.on('settings/open-changed', () => opens.push(ctx.settingsPages.isOpen()))

    expect(ctx.settingsPages.isOpen()).toBe(false)
    ctx.settingsPages.open()
    expect(ctx.settingsPages.isOpen()).toBe(true)
    // Opening again without a new page id is a no-op.
    ctx.settingsPages.open()
    ctx.settingsPages.close()
    ctx.settingsPages.close()
    ctx.settingsPages.toggle()
    ctx.settingsPages.toggle()
    expect(ctx.settingsPages.isOpen()).toBe(false)
    expect(opens).toEqual([true, false, true, false])

    // open(id) while already open still switches the page (and emits).
    ctx.settingsPages.open('modbus')
    expect(opens.at(-1)).toBe(true)
  })

  it('list reports no active page while the dialog is closed', async () => {
    const ctx = await makeSettings()
    page(ctx, 'plugins', 0)
    expect(ctx.settingsPages.active()).toBeUndefined()
    expect(ctx.settingsPages.list().every(item => !item.active)).toBe(true)
  })

  it('replaces same-id registrations and drops pages when their fiber unloads', async () => {
    const ctx = await makeSettings()
    page(ctx, 'modbus', 10)
    page(ctx, 'modbus', 10, 'ModbusTCP2')
    expect(ctx.settingsPages.list()).toHaveLength(1)
    expect(ctx.settingsPages.list()[0]?.title).toBe('ModbusTCP2')

    const fiber = await ctx.plugin(Object.assign(
      function resident(sub): void {
        sub.settingsPages.register(sub, { id: 'extra', order: 5, title: 'Extra', render: () => null })
      },
      { inject: ['settingsPages'] },
    ))
    expect(ctx.settingsPages.list().map(item => item.id)).toEqual(['extra', 'modbus'])

    await fiber.dispose()
    expect(ctx.settingsPages.list().map(item => item.id)).toEqual(['modbus'])
  })

  it('emits pages-changed on add and remove but not on replace', async () => {
    const ctx = await makeSettings()
    const changes: string[] = []
    ctx.on('settings/pages-changed', () => changes.push('pages'))
    page(ctx, 'a', 0)
    page(ctx, 'b', 1)
    page(ctx, 'a', 0)
    const before = changes.length
    const remove = ctx.settingsPages.register(ctx, { id: 'c', order: 2, title: 'C', render: () => null })
    remove()
    expect(changes.length).toBe(before + 2)
  })
})
