/**
 * The UI panel seam: a small vocabulary of well-known slots that any client
 * plugin can occupy, plus the `ctx.uiSlots` registry backing it. The
 * vocabulary is deliberately closed for phase 1; `custom:*` ids are the
 * reserved extension seat for community layouts.
 *
 * Degradation rule: every slot is optional. The layout owner decides what an
 * empty slot renders (usually nothing); nothing throws on a missing occupant.
 *
 * Occupancy modes: `stack` slots render every occupant in order (menu items,
 * actions); `single` slots render only the winner — the highest
 * `precedence`, ties by latest registration — so a component plugin can
 * replace a default tenant (a third-party titlebar over the suite's
 * built-in one) and unloading it falls back to the default automatically:
 * the default is never destroyed, only shadowed. The framework owns the mode
 * table for its standard slots; `custom:*` slots are stack.
 *
 * @module @snap-rail/framework-shadcn/slots
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'

/** Stable semantic slot names shared by every layout implementation. */
export const UI_SLOT_IDS = {
  layout: 'shell.layout',
  titlebar: 'shell.titlebar',
  titlebarActions: 'shell.titlebar.actions',
  menu: 'shell.menu',
  sidebar: 'shell.sidebar',
  main: 'shell.main',
  view: 'shell.view',
  statusbar: 'shell.statusbar',
  overlay: 'shell.overlay',
} as const

/** Runtime set used by manifest/semantic validation as well as TypeScript. */
export const STANDARD_UI_SLOT_IDS: ReadonlySet<string> = new Set(Object.values(UI_SLOT_IDS))

/** A custom slot is owned by a publisher and a local slot name. */
export const CUSTOM_UI_SLOT_PATTERN = /^custom:[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/

/** Check the public slot naming contract at runtime. */
export function isValidUiSlotId(value: string): value is SlotId {
  return STANDARD_UI_SLOT_IDS.has(value) || CUSTOM_UI_SLOT_PATTERN.test(value)
}

/** A layout may add a namespaced extension slot without changing the core vocabulary. */
export type SlotId = typeof UI_SLOT_IDS[keyof typeof UI_SLOT_IDS] | `custom:${string}`

/** How a slot renders its occupants: all in order, or one elected winner. */
export type UiSlotMode = 'stack' | 'single'

/**
 * The mode table for the standard slots — the framework owns it.
 *
 * `titlebar` and `main` are `single`: exactly one tenant renders (a skin or
 * replacement displaces the default and falls back on unload). `layout`
 * stays `stack` on purpose — the settings dialog is a permanent overlay
 * occupant beside the active layout, and the fallback shell yields by
 * counting; every other slot collects contributions.
 */
export const UI_SLOT_MODES = {
  [UI_SLOT_IDS.layout]: 'stack',
  [UI_SLOT_IDS.titlebar]: 'single',
  [UI_SLOT_IDS.titlebarActions]: 'stack',
  [UI_SLOT_IDS.menu]: 'stack',
  [UI_SLOT_IDS.sidebar]: 'stack',
  [UI_SLOT_IDS.main]: 'single',
  [UI_SLOT_IDS.view]: 'stack',
  [UI_SLOT_IDS.statusbar]: 'stack',
  [UI_SLOT_IDS.overlay]: 'stack',
} as const satisfies Record<string, UiSlotMode>

const STANDARD_SLOT_MODES: ReadonlyMap<string, UiSlotMode> = new Map(Object.entries(UI_SLOT_MODES))

/** The occupancy mode of a slot; `custom:*` slots are `stack`. */
export function slotModeOf(slot: SlotId): UiSlotMode {
  return STANDARD_SLOT_MODES.get(slot) ?? 'stack'
}

/** What one occupant contributes to a slot. */
export interface SlotOccupant {
  /** Stable plugin-chosen key; later registrations with it replace earlier ones. */
  id: string
  /** Rendering order within the slot; ties break by registration time. */
  order: number
  /**
   * Winner election for `single` slots: the highest value renders, and
   * unloading it falls back to the next (a built-in default stays at 0, an
   * override registers higher). Ignored in `stack` slots. Default 0.
   */
  precedence?: number
  render(): ReactNode
}

/** Registry of slot occupants exposed as `ctx.uiSlots`. */
export interface UiSlotsService {
  /**
   * Current occupants of a slot in render order. `single` slots answer with
   * at most one occupant — the elected winner.
   *
   * @param slot - the slot to read.
   */
  list(slot: SlotId): readonly SlotOccupant[]
  /** Occupy a slot; disposal removes the occupant.
   * @param slot - target slot.
   * @param occupant - the contribution; same-id re-registration replaces.
   * @param caller - owning context; unload drops the occupant.
   */
  register(caller: Context, slot: SlotId, occupant: SlotOccupant): () => void
}

declare module '@snap-rail/cordis' {
  interface Context {
    uiSlots: UiSlotsService
  }

  interface Events {
    /** A slot's occupants changed (any add, replace, or removal).
     * @param slot - the affected slot id.
     */
    'ui/slot-changed'(slot: SlotId): void
  }
}

interface RegistryEntry {
  occupants: Map<string, { occupant: SlotOccupant, seq: number }>
  nextSeq: number
}

/** Mounts the `ctx.uiSlots` registry.
 *
 * The facade binds everything to construction-time closures: traceable
 * context proxies rebind `this` on every method access, so `this`-reached
 * state cannot back a service here (mirrors the field seam's external core).
 */
const slotsPlugin: Plugin.Object<void> = {
  name: 'framework slots',
  apply(ctx: Context): void {
    const slots = new Map<SlotId, RegistryEntry>()
    const entryOf = (slot: SlotId): RegistryEntry => {
      let entry = slots.get(slot)
      if (entry === undefined) {
        entry = { occupants: new Map(), nextSeq: 0 }
        slots.set(slot, entry)
      }
      return entry
    }

    ctx.provide('uiSlots', {
      list(slot: SlotId): readonly SlotOccupant[] {
        const entry = entryOf(slot)
        const ranked = [...entry.occupants.values()]
          .sort((a, b) => a.occupant.order - b.occupant.order || a.seq - b.seq)
        if (slotModeOf(slot) === 'single' && ranked.length > 0) {
          // Winner election: precedence first, latest registration breaks
          // ties. Losers stay registered — dropping the winner falls back.
          const winner = ranked.reduce((best, item) => {
            const byPrecedence = (item.occupant.precedence ?? 0) - (best.occupant.precedence ?? 0)
            return byPrecedence > 0 || (byPrecedence === 0 && item.seq > best.seq) ? item : best
          })
          return [winner.occupant]
        }
        return ranked.map(item => item.occupant)
      },
      register(caller: Context, slot: SlotId, occupant: SlotOccupant): () => void {
        const entry = entryOf(slot)
        entry.occupants.set(occupant.id, { occupant, seq: entry.nextSeq++ })
        ctx.emit('ui/slot-changed', slot)
        const remove = (): void => {
          // Disposal is by occupant id: an earlier handle still removes the
          // seat after a same-id replacement (fiber unload drops the current
          // occupant), and repeat calls are no-ops.
          if (entry.occupants.delete(occupant.id)) ctx.emit('ui/slot-changed', slot)
        }
        // Effects take a body producing the disposer; passing `remove`
        // itself would run it as setup.
        caller.effect(() => remove)
        return remove
      },
    })
  },
}

export default slotsPlugin
