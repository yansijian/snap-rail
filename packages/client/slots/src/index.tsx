/**
 * The UI panel seam: a small vocabulary of well-known slots that any client
 * plugin can occupy, plus the `ctx.uiSlots` registry backing it. The
 * vocabulary is deliberately closed for phase 1; `custom:*` ids are the
 * reserved extension seat for community layouts.
 *
 * Degradation rule: every slot is optional. The layout owner decides what an
 * empty slot renders (usually nothing); nothing throws on a missing occupant.
 *
 * @module @snap-rail/client-slots
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'

/** Well-known slot ids (the closed phase-1 vocabulary). */
export type SlotId = 'titlebar' | 'sidebar' | 'view' | 'statusbar' | 'layout' | `custom:${string}`

/** What one occupant contributes to a slot. */
export interface SlotOccupant {
  /** Stable plugin-chosen key; later registrations with it replace earlier ones. */
  id: string
  /** Rendering order within the slot; ties break by registration time. */
  order: number
  render(): ReactNode
}

/** Registry of slot occupants exposed as `ctx.uiSlots`. */
export interface UiSlotsService {
  /** Current occupants of a slot in render order.
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
  name: 'client-slots',
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
        return [...entry.occupants.values()]
          .sort((a, b) => a.occupant.order - b.occupant.order || a.seq - b.seq)
          .map(item => item.occupant)
      },
      register(caller: Context, slot: SlotId, occupant: SlotOccupant): () => void {
        const entry = entryOf(slot)
        entry.occupants.set(occupant.id, { occupant, seq: entry.nextSeq++ })
        ctx.emit('ui/slot-changed', slot)
        const remove = (): void => {
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
