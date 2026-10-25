import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import slotsPlugin from '../src/slots.tsx'
import { UI_SLOT_IDS } from '../src/contract.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeUi(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(slotsPlugin)
  return ctx
}

describe('ctx.ui region slots', () => {
  it('orders contributions by order then registration time', async () => {
    const ctx = await makeUi()
    ctx.ui.contribute(ctx, UI_SLOT_IDS.statusbar, { id: 'b', order: 1, render: () => 'B' })
    ctx.ui.contribute(ctx, UI_SLOT_IDS.statusbar, { id: 'a', order: 0, render: () => 'A' })
    ctx.ui.contribute(ctx, UI_SLOT_IDS.statusbar, { id: 'c', order: 1, render: () => 'C' })

    expect(ctx.ui.list(UI_SLOT_IDS.statusbar).map(item => item.render(undefined))).toEqual(['A', 'B', 'C'])
  })

  it('elects one winner for one-mode slots and falls back when it unloads', async () => {
    const ctx = await makeUi()
    ctx.ui.contribute(ctx, UI_SLOT_IDS.settingsEntry, { id: 'default', order: 0, render: () => 'default' })
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.render({}))).toEqual(['default'])

    const fiber = await ctx.plugin(Object.assign(
      function override(sub): void {
        sub.ui.contribute(sub, UI_SLOT_IDS.settingsEntry, {
          id: 'custom',
          order: 0,
          precedence: 10,
          render: () => 'custom',
        })
      },
      { inject: ['ui'] },
    ))
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.render({}))).toEqual(['custom'])

    await fiber.dispose()
    expect(ctx.ui.list(UI_SLOT_IDS.settingsEntry).map(item => item.render({}))).toEqual(['default'])
  })

  it('tracks the active layout and only reports its declared slots as provided', async () => {
    const ctx = await makeUi()
    expect(ctx.ui.activeLayout()).toBeUndefined()
    expect(ctx.ui.hasProvider(UI_SLOT_IDS.settingsEntry)).toBe(false)

    ctx.ui.registerLayout(ctx, {
      id: 'station',
      order: 0,
      provides: [UI_SLOT_IDS.titlebar, UI_SLOT_IDS.settingsEntry],
      render: () => null,
    })
    expect(ctx.ui.activeLayout()?.id).toBe('station')
    expect(ctx.ui.hasProvider(UI_SLOT_IDS.settingsEntry)).toBe(true)
    expect(ctx.ui.hasProvider(UI_SLOT_IDS.statusbar)).toBe(false)
  })

  it('prefers the highest-precedence layout and falls back when it unloads', async () => {
    const ctx = await makeUi()
    ctx.ui.registerLayout(ctx, { id: 'fallback', order: 200, provides: [], render: () => null })
    const fiber = await ctx.plugin(Object.assign(
      function layout(sub): void {
        sub.ui.registerLayout(sub, {
          id: 'suite',
          order: 0,
          precedence: 10,
          provides: [],
          render: () => null,
        })
      },
      { inject: ['ui'] },
    ))
    expect(ctx.ui.activeLayout()?.id).toBe('suite')
    await fiber.dispose()
    expect(ctx.ui.activeLayout()?.id).toBe('fallback')
  })

  it('diagnoses contributions to undeclared slots without throwing', async () => {
    const ctx = await makeUi()
    ctx.ui.contribute(ctx, 'custom:acme.panel', { id: 'widget', order: 0, render: () => 'x' })
    expect(ctx.ui.list('custom:acme.panel')).toHaveLength(1)
    expect(ctx.ui.diagnostics().some(item => item.kind === 'unknown-slot')).toBe(true)
  })

  it('drops contributions and layouts when their fiber unloads', async () => {
    const ctx = await makeUi()
    const fiber = await ctx.plugin(Object.assign(
      function feature(sub): void {
        sub.ui.registerLayout(sub, { id: 'feature-layout', order: 0, provides: [], render: () => null })
        sub.ui.contribute(sub, UI_SLOT_IDS.overlay, { id: 'dialog', order: 0, render: () => 'dialog' })
      },
      { inject: ['ui'] },
    ))
    expect(ctx.ui.list(UI_SLOT_IDS.overlay)).toHaveLength(1)
    expect(ctx.ui.activeLayout()?.id).toBe('feature-layout')

    await fiber.dispose()
    expect(ctx.ui.list(UI_SLOT_IDS.overlay)).toHaveLength(0)
    expect(ctx.ui.activeLayout()).toBeUndefined()
  })
})