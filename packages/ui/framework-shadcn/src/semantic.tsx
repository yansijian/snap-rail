/** Framework-neutral semantic UI contributions.
 *
 * Layouts own the visual arrangement. Components publish views, navigation
 * entries and actions against stable semantic slots, so the same component can
 * move between layouts without importing a layout package.
 *
 * @module @snap-rail/framework-shadcn/semantic
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { SlotId, SlotOccupant, UiSlotsService } from './slots.tsx'
import { isValidUiSlotId, UI_SLOT_IDS } from './slots.tsx'

/** A view contributed by a UI component plugin. */
export interface UiViewContribution extends SlotOccupant {
  /** Human-facing label for menus and accessibility surfaces. */
  title: string
  /** The semantic slot where the view is rendered. */
  slot: SlotId
}

/** A layout contribution that consumes semantic slots. */
export interface UiLayoutContribution extends SlotOccupant {
  /** Slots this layout defines and renders. */
  slots: readonly SlotId[]
}

/** A navigation entry that targets a contributed view id. */
export interface UiNavigationContribution {
  id: string
  label: string
  viewId: string
  order: number
}

/** The shared UI contract service exposed to all client plugins. */
export interface UiContractService {
  registerView(caller: Context, contribution: UiViewContribution): () => void
  registerLayout(caller: Context, contribution: UiLayoutContribution): () => void
  registerNavigation(caller: Context, contribution: UiNavigationContribution): () => void
  listViews(): readonly UiViewContribution[]
  listLayouts(): readonly UiLayoutContribution[]
  listNavigation(): readonly UiNavigationContribution[]
}

declare module '@snap-rail/cordis' {
  interface Context {
    uiContract: UiContractService
  }

  interface Events {
    'ui/semantic-changed'(kind: 'view' | 'layout' | 'navigation'): void
    /** A contribution used an unknown or malformed semantic slot. */
    'ui/semantic-invalid'(kind: 'view' | 'layout', id: string, slot: string): void
  }
}

interface Stored<T> {
  value: T
  seq: number
}

/** Mount the semantic contribution registry on top of the slot registry. */
const semanticPlugin: Plugin.Object<void> = {
  name: 'framework semantic ui contract',
  inject: ['uiSlots'],
  apply(ctx: Context): void {
    const slots: UiSlotsService = ctx.uiSlots
    const views = new Map<string, Stored<UiViewContribution>>()
    const layouts = new Map<string, Stored<UiLayoutContribution>>()
    const navigation = new Map<string, Stored<UiNavigationContribution>>()
    let sequence = 0

    const ordered = <T extends { order: number }>(values: Iterable<Stored<T>>): readonly T[] =>
      [...values].sort((a, b) => a.value.order - b.value.order || a.seq - b.seq).map(item => item.value)

    const register = <T>(
      table: Map<string, Stored<T>>,
      caller: Context,
      id: string,
      value: T,
      disposeSlot?: () => void,
    ): (() => void) => {
      table.set(id, { value, seq: sequence++ })
      const kind = table === views ? 'view' : table === layouts ? 'layout' : 'navigation'
      ctx.emit('ui/semantic-changed', kind)
      const remove = (): void => {
        if (table.get(id)?.value === value) {
          table.delete(id)
          disposeSlot?.()
          ctx.emit('ui/semantic-changed', kind)
        }
      }
      caller.effect(() => remove)
      return remove
    }

    const validateSlot = (kind: 'view' | 'layout', id: string, slot: string): void => {
      if (!isValidUiSlotId(slot)) ctx.emit('ui/semantic-invalid', kind, id, slot)
    }

    ctx.provide('uiContract', {
      registerView(caller: Context, contribution: UiViewContribution): () => void {
        validateSlot('view', contribution.id, contribution.slot)
        const disposeSlot = slots.register(caller, contribution.slot, contribution)
        return register(views, caller, contribution.id, contribution, disposeSlot)
      },
      registerLayout(caller: Context, contribution: UiLayoutContribution): () => void {
        for (const slot of contribution.slots) validateSlot('layout', contribution.id, slot)
        const disposeSlot = slots.register(caller, UI_SLOT_IDS.layout, contribution)
        return register(layouts, caller, contribution.id, contribution, disposeSlot)
      },
      registerNavigation(caller: Context, contribution: UiNavigationContribution): () => void {
        return register(navigation, caller, contribution.id, contribution)
      },
      listViews: () => ordered(views.values()),
      listLayouts: () => ordered(layouts.values()),
      listNavigation: () => ordered(navigation.values()),
    } satisfies UiContractService)
  },
}

export default semanticPlugin
