// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import slotsPlugin from '../src/slots.tsx'
import { UI_SLOT_IDS, type SlotId } from '../src/slots.tsx'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeSlots(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(slotsPlugin)
  return ctx
}

function occupant(ctx: Context, id: string, order: number, label: string): void {
  ctx.uiSlots.register(ctx, UI_SLOT_IDS.view, { id, order, render: () => label })
}

describe('uiSlots', () => {
  it('orders occupants by order then registration time', async () => {
    const ctx = await makeSlots()
    occupant(ctx, 'b', 1, 'B')
    occupant(ctx, 'a', 0, 'A')
    occupant(ctx, 'c', 1, 'C')

    expect(ctx.uiSlots.list(UI_SLOT_IDS.view).map(item => item.render())).toEqual(['A', 'B', 'C'])
  })

  it('degrades to empty for unknown slots without throwing', async () => {
    const ctx = await makeSlots()
    expect(ctx.uiSlots.list(UI_SLOT_IDS.statusbar)).toEqual([])
    expect(ctx.uiSlots.list('custom:dock' as SlotId)).toEqual([])
  })

  it('replaces same-id registrations and emits one change each way', async () => {
    const ctx = await makeSlots()
    const changes: string[] = []
    ctx.on('ui/slot-changed', slot => changes.push(slot))
    const detach = ctx.uiSlots.register(ctx, UI_SLOT_IDS.view, { id: 'one', order: 0, render: () => 'first' })
    ctx.uiSlots.register(ctx, UI_SLOT_IDS.view, { id: 'one', order: 0, render: () => 'second' })

    expect(ctx.uiSlots.list(UI_SLOT_IDS.view)[0]?.render()).toBe('second')
    ctx.uiSlots.register(ctx, UI_SLOT_IDS.view, { id: 'two', order: 1, render: () => 'x' })
    const before = changes.length
    detach()
    expect(changes.length).toBe(before + 1)
    // A second call after removal is a no-op.
    detach()
    expect(changes.length).toBe(before + 1)
    expect(changes.filter(slot => slot !== UI_SLOT_IDS.view)).toEqual([])
  })

  it('drops occupants when their registering fiber unloads', async () => {
    const ctx = await makeSlots()
    const fiber = await ctx.plugin(Object.assign(
      function dash(sub): void {
        sub.uiSlots.register(sub, UI_SLOT_IDS.sidebar, { id: 'tree', order: 0, render: () => 'tree' })
      },
      { inject: ['uiSlots'] },
    ))
    expect(ctx.uiSlots.list(UI_SLOT_IDS.sidebar)).toHaveLength(1)

    await fiber.dispose()
    expect(ctx.uiSlots.list(UI_SLOT_IDS.sidebar)).toEqual([])
  })

  it('renders nothing for a slot without occupants (degradation rule)', async () => {
    const ctx = await makeSlots()
    expect(ctx.uiSlots.list(UI_SLOT_IDS.titlebar).map(item => item.render())).toEqual([])
  })
})
