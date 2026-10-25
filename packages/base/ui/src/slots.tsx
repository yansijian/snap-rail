/**
 * The typed region-slot registry behind `ctx.ui` and the `<Slot>` outlet.
 *
 * A layout declares which slots it provides; features and pages contribute
 * against stable ids with a scoped context. A contribution registered before
 * its layout mounts stays dormant; a contribution whose context does not fit
 * is skipped with a diagnostic instead of crashing the shell.
 *
 * @module @snap-rail/ui/slots
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import {
  Component,
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  UI_SLOT_IDS,
  UI_SLOT_MODES,
  isValidSlotId,
  type LayoutContribution,
  type SlotContribution,
  type SlotDefinition,
  type SlotMode,
  type UiDiagnostic,
} from './contract.ts'

/** The service exposed as `ctx.ui`. */
export interface UiService {
  /** Declare a slot (built-ins are predeclared); disposal removes the declaration. */
  defineSlot<C>(caller: Context, def: SlotDefinition<C>): () => void
  /** Register the active layout candidate; disposal removes it. */
  registerLayout(caller: Context, layout: LayoutContribution): () => void
  /** Contribute to a slot; disposal removes the contribution. */
  contribute<C>(caller: Context, slot: string, contribution: SlotContribution<C>): () => void
  /** Current contributions of a slot in render order (one winner for `one`). */
  list(slot: string): readonly SlotContribution<unknown>[]
  /** The declared definition of a slot, when one exists. */
  definition(slot: string): SlotDefinition<unknown> | undefined
  /** The winning layout, or `undefined` when none registered. */
  activeLayout(): LayoutContribution | undefined
  /** Whether the active layout provides a slot. */
  hasProvider(slot: string): boolean
  /** The non-fatal contract violations observed so far. */
  diagnostics(): readonly UiDiagnostic[]
  /** Subscribe to registry changes (React `useSyncExternalStore` shape). */
  subscribe(listener: () => void): () => void
  /** Monotonic registry version. */
  version(): number
}

declare module '@snap-rail/cordis' {
  interface Context {
    ui: UiService
  }

  interface Events {
    /** The slot/layout registry changed. */
    'ui/changed'(): void
    /** One slot's occupants changed.
     * @param slot - the affected slot id.
     */
    'ui/slot-changed'(slot: string): void
  }
}

interface StoredContribution {
  contribution: SlotContribution<unknown>
  seq: number
}

interface StoredLayout {
  layout: LayoutContribution
  seq: number
}

interface SlotEntry {
  def: SlotDefinition<unknown>
  contributions: Map<string, StoredContribution>
  nextSeq: number
}

const MAX_DIAGNOSTICS = 100

/** The default definition of a built-in slot. */
function builtinDefinition(slot: string): SlotDefinition<unknown> {
  return {
    id: slot,
    mode: (UI_SLOT_MODES as Record<string, SlotMode>)[slot] ?? 'many',
  }
}

/** Mount the `ctx.ui` registry. */
const slotsPlugin: Plugin.Object<void> = {
  name: 'snap-rail ui slots',
  apply(ctx: Context): void {
    const entries = new Map<string, SlotEntry>()
    const layouts = new Map<string, StoredLayout>()
    const listeners = new Set<() => void>()
    const diagnostics: UiDiagnostic[] = []
    let revision = 0
    let layoutSeq = 0

    for (const slot of Object.values(UI_SLOT_IDS)) {
      entries.set(slot, {
        def: builtinDefinition(slot),
        contributions: new Map(),
        nextSeq: 0,
      })
    }

    const notify = (slot?: string): void => {
      revision += 1
      for (const listener of listeners) listener()
      ctx.emit('ui/changed')
      if (slot !== undefined) ctx.emit('ui/slot-changed', slot)
    }

    const diagnose = (diagnostic: Omit<UiDiagnostic, 'time'>): void => {
      diagnostics.push({ ...diagnostic, time: Date.now() })
      if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift()
    }

    const activeLayoutOf = (): LayoutContribution | undefined => {
      const ranked = [...layouts.values()].sort((a, b) => {
        const pa = a.layout.precedence ?? 0
        const pb = b.layout.precedence ?? 0
        return pb - pa || a.layout.order - b.layout.order || b.seq - a.seq
      })
      return ranked[0]?.layout
    }

    const ensureEntry = (slot: string): SlotEntry => {
      const existing = entries.get(slot)
      if (existing !== undefined) return existing
      const entry: SlotEntry = {
        def: { id: slot, mode: 'many' },
        contributions: new Map(),
        nextSeq: 0,
      }
      entries.set(slot, entry)
      return entry
    }

    ctx.provide('ui', {
      defineSlot<C>(caller: Context, def: SlotDefinition<C>): () => void {
        if (!isValidSlotId(def.id)) {
          diagnose({ kind: 'unknown-slot', slot: def.id, message: `插槽 id 不合法：${def.id}` })
          return () => {}
        }
        if ((Object.values(UI_SLOT_IDS) as readonly string[]).includes(def.id)) {
          diagnose({ kind: 'duplicate-id', slot: def.id, message: `内置插槽不能被重新定义：${def.id}` })
          return () => {}
        }
        const entry = ensureEntry(def.id)
        entry.def = def as SlotDefinition<unknown>
        notify(def.id)
        const remove = (): void => {
          if (entries.delete(def.id)) notify(def.id)
        }
        caller.effect(() => remove)
        return remove
      },

      registerLayout(caller: Context, layout: LayoutContribution): () => void {
        for (const slot of layout.provides) {
          if (!isValidSlotId(slot)) {
            diagnose({ kind: 'unknown-slot', id: layout.id, slot, message: `布局 ${layout.id} 声明了非法插槽：${slot}` })
          } else if (!entries.has(slot)) {
            diagnose({ kind: 'unknown-slot', id: layout.id, slot, message: `布局 ${layout.id} 声明了未定义的插槽：${slot}` })
          }
        }
        layouts.set(layout.id, { layout, seq: layoutSeq++ })
        notify()
        const remove = (): void => {
          if (layouts.delete(layout.id)) notify()
        }
        caller.effect(() => remove)
        return remove
      },

      contribute<C>(caller: Context, slot: string, contribution: SlotContribution<C>): () => void {
        if (!isValidSlotId(slot)) {
          diagnose({ kind: 'unknown-slot', id: contribution.id, slot, message: `贡献 ${contribution.id} 指向非法插槽：${slot}` })
          return () => {}
        }
        const entry = entries.get(slot)
        if (entry === undefined) {
          diagnose({ kind: 'unknown-slot', id: contribution.id, slot, message: `贡献 ${contribution.id} 指向未定义的插槽：${slot}` })
        }
        const target = entry ?? ensureEntry(slot)
        target.contributions.set(contribution.id, {
          contribution: contribution as SlotContribution<unknown>,
          seq: target.nextSeq++,
        })
        notify(slot)
        const remove = (): void => {
          if (target.contributions.delete(contribution.id)) notify(slot)
        }
        caller.effect(() => remove)
        return remove
      },

      list(slot: string): readonly SlotContribution<unknown>[] {
        const entry = entries.get(slot)
        if (entry === undefined) return []
        const ranked = [...entry.contributions.values()]
          .sort((a, b) => a.contribution.order - b.contribution.order || a.seq - b.seq)
        if (entry.def.mode !== 'one' || ranked.length === 0) {
          return ranked.map(item => item.contribution)
        }
        const winner = ranked.reduce((best, item) => {
          const delta = (item.contribution.precedence ?? 0) - (best.contribution.precedence ?? 0)
          return delta > 0 || (delta === 0 && item.seq > best.seq) ? item : best
        })
        return [winner.contribution]
      },

      definition: (slot: string) => entries.get(slot)?.def,
      activeLayout: activeLayoutOf,
      hasProvider(slot: string): boolean {
        const active = activeLayoutOf()
        return active !== undefined && active.provides.includes(slot as never)
      },

      diagnostics: () => diagnostics,
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      version: () => revision,
    } satisfies UiService)
  },
}

/** The React context carrying the active UI service. */
const UiContext = createContext<UiService | null>(null)

/** Provide the UI service to a slot tree. */
export function UiProvider(props: { service: UiService; children: ReactNode }): ReactNode {
  return <UiContext.Provider value={props.service}>{props.children}</UiContext.Provider>
}

/** Read the UI service; throws when a slot tree is mounted outside the runtime. */
export function useUi(): UiService {
  const service = useContext(UiContext)
  if (service === null) throw new Error('useUi: no UiProvider in the tree')
  return service
}

/** Re-render on every registry change. */
export function useUiVersion(service: UiService): number {
  return useSyncExternalStore(service.subscribe, service.version, service.version)
}

/** Boundary payload for a failed slot contribution. */
interface SlotBoundaryState {
  failed: boolean
}

/** Keep one broken contribution from taking down the whole shell. */
class SlotBoundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false }

  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error)
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** A region-slot outlet rendered by a layout. */
export function Slot<C = unknown>(props: { name: string; context?: C }): ReactNode {
  const service = useUi()
  useUiVersion(service)
  const provided = service.hasProvider(props.name)
  const entry = service.list(props.name)
  const def = service.definition(props.name)
  const context = (props.context ?? {}) as C

  if (!provided) {
    // A layout that renders a slot it did not declare is a contract bug, but
    // the shell still renders the fallback rather than throwing.
    return null
  }
  if (entry.length === 0) {
    const fallback = def?.fallback as ((context: C) => ReactNode) | undefined
    return fallback?.(context) ?? null
  }
  return (
    <>
      {entry.map(item => (
        <SlotBoundary
          key={item.id}
          onError={error => {
            console.error(`[snap-rail ui] slot ${props.name} contribution ${item.id} failed`, error)
          }}
        >
          {item.render(context)}
        </SlotBoundary>
      ))}
    </>
  )
}

/** Re-render when the active layout changes. */
export function useActiveLayout(): LayoutContribution | undefined {
  const service = useUi()
  useUiVersion(service)
  return service.activeLayout()
}

export default slotsPlugin