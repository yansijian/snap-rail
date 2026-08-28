/**
 * The workflow seam: `ctx.workflows` is a generic registry-plus-evaluator —
 * it knows the mechanism (registration, gating, alerts) and nothing about any
 * concrete workflow. The gating chain emerges from each occupant's
 * declarative `requires`; the truth source for satisfaction is the audit
 * event stream fed back by the layout (`audit.list` on boot/login) and
 * extended in-session by `announce` after a plugin records an event.
 *
 * @module @snap-rail/client-workflows
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'

/** How a requirement's event counts as satisfying (who, and when). */
export type RequirementScope = 'operator-day' | 'day'

/** One gating declaration: satisfied when a matching event exists. */
export interface Requirement {
  /** The audit action that satisfies the requirement. */
  action: string
  /** `operator-day`: the current operator, today. `day`: anyone, today. */
  scope: RequirementScope
}

/** A sidebar attention effect driven by the workflow owner. */
export type WorkflowAlert =
  | { kind: 'steady', color: 'red' | 'yellow' }
  | { kind: 'halo', progress: number }

/** What one workflow contributes at registration. */
export interface WorkflowDef {
  /** Stable workflow id (the sidebar and content key). */
  id: string
  /** Sidebar label; locked items render gray with no extra text. */
  title: string
  /** Sidebar ordering; ties break by registration time. */
  order: number
  /** Gating declarations; empty means always unlocked. */
  requires: readonly Requirement[]
  render(): ReactNode
}

/** A workflow as the sidebar/content sees it, with derived state. */
export interface WorkflowEntry extends WorkflowDef {
  /** Whether the gating declarations are satisfied right now. */
  unlocked: boolean
  /** Whether this workflow is the active content page. */
  active: boolean
  /** The current sidebar attention effect, or `null`. */
  alert: WorkflowAlert | null
}

/** One business event used for gating evaluation. */
export interface WorkflowEvent {
  action: string
  actor: string
  time: number
}

/** Workflow registry exposed as `ctx.workflows`. */
export interface WorkflowsService {
  /** Registered workflows in sidebar order with derived state. */
  list(): readonly WorkflowEntry[]
  /** Register one workflow; disposal (caller unload) removes it.
   * @param caller - owning context; unload drops the workflow.
   * @param def - the contribution; same-id re-registration replaces.
   */
  register(caller: Context, def: WorkflowDef): () => void
  /** Make one workflow the active content page. */
  setActive(id: string): void
  /** Set or clear a sidebar attention effect.
   * @param id - the workflow id.
   * @param alert - the effect, or `null` to clear.
   */
  setAlert(id: string, alert: WorkflowAlert | null): void
  /** Set the gating anchor operator (`operator-day` scope re-evaluates). */
  setOperator(operator: string | null): void
  /** Replace the event set (from `audit.list`) and re-evaluate gating. */
  feedEvents(events: readonly WorkflowEvent[]): void
  /** Append one in-session event (after the plugin recorded it host-side).
   * @param action - the audit action.
   * @param actor - defaults to the current anchor operator.
   */
  announce(action: string, actor?: string): void
}

declare module '@snap-rail/cordis' {
  interface Context {
    workflows: WorkflowsService
  }

  interface Events {
    /** Registry, active page, alert, or gating state changed. */
    'workflow/changed'(): void
  }
}

/** Whether two epoch-ms times fall on the same local calendar day. */
function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

interface RegistryEntry {
  def: WorkflowDef
  alert: WorkflowAlert | null
  seq: number
}

/**
 * Mounts the `ctx.workflows` registry. All state lives in construction-time
 * closures: traceable context proxies rebind `this` on every method access,
 * so `this`-reached state cannot back a service here (the uiSlots lesson).
 */
const workflowsPlugin: Plugin.Object<void> = {
  name: 'client-workflows',
  apply(ctx: Context): void {
    const workflows = new Map<string, RegistryEntry>()
    let nextSeq = 0
    let activeId: string | undefined
    let operator: string | null = null
    let events: readonly WorkflowEvent[] = []

    const satisfies = (requirement: Requirement): boolean =>
      events.some(event => event.action === requirement.action
        && (requirement.scope === 'day'
          ? sameLocalDay(event.time, Date.now())
          : event.actor === operator && sameLocalDay(event.time, Date.now())))

    const changed = (): void => {
      ctx.emit('workflow/changed')
    }

    ctx.provide('workflows', {
      list(): readonly WorkflowEntry[] {
        return [...workflows.values()]
          .sort((a, b) => a.def.order - b.def.order || a.seq - b.seq)
          .map(({ def, alert }) => ({
            ...def,
            unlocked: def.requires.every(satisfies),
            active: def.id === activeId,
            alert,
          }))
      },
      register(caller: Context, def: WorkflowDef): () => void {
        workflows.set(def.id, { def, alert: null, seq: nextSeq++ })
        changed()
        const remove = (): void => {
          if (workflows.delete(def.id)) {
            if (activeId === def.id) activeId = undefined
            changed()
          }
        }
        // Effects take a body producing the disposer; passing `remove`
        // itself would run it as setup.
        caller.effect(() => remove)
        return remove
      },
      setActive(id: string): void {
        if (activeId === id) return
        activeId = id
        changed()
      },
      setAlert(id: string, alert: WorkflowAlert | null): void {
        const entry = workflows.get(id)
        if (entry === undefined || entry.alert === alert) return
        if (alert !== null && alert.kind === 'halo') {
          alert = { kind: 'halo', progress: Math.min(1, Math.max(0, alert.progress)) }
        }
        entry.alert = alert
        changed()
      },
      setOperator(next: string | null): void {
        if (operator === next) return
        operator = next
        changed()
      },
      feedEvents(next: readonly WorkflowEvent[]): void {
        events = [...next].sort((a, b) => a.time - b.time)
        changed()
      },
      announce(action: string, actor?: string): void {
        events = [...events, { action, actor: actor ?? operator ?? 'client', time: Date.now() }]
        changed()
      },
    })
  },
}

export default workflowsPlugin
