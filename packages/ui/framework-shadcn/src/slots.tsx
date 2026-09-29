/**
 * The UI panel seam: a small vocabulary of well-known slots that any client
 * plugin can occupy, plus the `ctx.uiSlots` registry backing it. The
 * vocabulary is deliberately closed for phase 1; `custom:*` ids are the
 * reserved extension seat for community layouts.
 *
 * Degradation rule: every slot is optional. The layout owner decides what an
 * empty slot renders (usually nothing); nothing throws on a missing occupant.
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
        return [...entry.occupants.values()]
          .sort((a, b) => a.occupant.order - b.occupant.order || a.seq - b.seq)
          .map(item => item.occupant)
      },
      register(caller: Context, slot: SlotId, occupant: SlotOccupant): () => void {
        const entry = entryOf(slot)
        entry.occupants.set(occupant.id, { occupant, seq: entry.nextSeq++ })
        ctx.emit('ui/slot-changed', slot)
        const remove = (): void => {
          if (entry.occupants.get(occupant.id)?.occupant === occupant) {
            entry.occupants.delete(occupant.id)
            ctx.emit('ui/slot-changed', slot)
          }
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
