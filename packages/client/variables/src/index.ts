/**
 * The variable seam: demand plugins declare the process variables they
 * listen to — a name and a semantic type, nothing protocol-specific — and
 * mapping surfaces (a driver's settings page) list the registry to wire
 * those names onto real devices. The variable name doubles as the field
 * point id, so consumers ride the existing `points.subscribe` /
 * `point/updated` path unchanged and a remap never re-keys the stream.
 *
 * Names are globally unique: a same-name registration replaces the earlier
 * one (the field seam would reject the duplicate point otherwise).
 *
 * @module @snap-rail/client-variables
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { PointType, PointValue } from '@snap-rail/protocol'
import { useEffect, useState } from 'react'

/** The slice of `ctx.client` this package needs; typed locally so the
 * variables package never references the runtime project (a reference
 * cycle: the runtime mounts this plugin). */
interface ClientLink {
  link: HostLink
}

/** What one demand plugin contributes: the variable it wants to hear about. */
export interface VariableDef {
  /** Globally unique variable name; also the field point id. */
  name: string
  /** Semantic value type (the field seam's type vocabulary). */
  type: PointType
  /** Human-facing label for mapping surfaces. */
  title?: string
}

/** A registered variable as mapping surfaces see it. */
export interface VariableEntry extends VariableDef {
  /** Where the declaration came from (phase 1: plugin code only). */
  source: 'plugin'
}

/** Variable registry exposed as `ctx.variables`. */
export interface VariablesService {
  /** Registered variables in registration order. */
  list(): readonly VariableEntry[]
  /** Register variables; disposal (caller unload) removes them all.
   * Same-name re-registration replaces; a name owned by another plugin's
   * live registration is replaced too (names are the uniqueness contract).
   * @param caller - owning context; unload drops every def in the call.
   * @param defs - the declarations; duplicate names inside one call throw.
   */
  register(caller: Context, defs: readonly VariableDef[]): () => void
}

declare module '@snap-rail/cordis' {
  interface Context {
    variables: VariablesService
  }

  interface Events {
    /** The variable registry changed (add, replace, or removal). */
    'variables/changed'(): void
  }
}

/**
 * Mounts the `ctx.variables` registry. All state lives in construction-time
 * closures: traceable context proxies rebind `this` on every method access,
 * so `this`-reached state cannot back a service here (the uiSlots lesson).
 */
const variablesPlugin: Plugin.Object<void> = {
  name: 'client-variables',
  apply(ctx: Context): void {
    const variables = new Map<string, VariableEntry>()

    ctx.provide('variables', {
      list(): readonly VariableEntry[] {
        return [...variables.values()]
      },
      register(caller: Context, defs: readonly VariableDef[]): () => void {
        const names = defs.map(def => def.name)
        if (new Set(names).size !== names.length) {
          throw new Error(`variables: duplicate names in one registration: ${names.join(', ')}`)
        }
        const installed: Array<{ name: string, entry: VariableEntry }> = []
        for (const def of defs) {
          const entry: VariableEntry = { ...def, source: 'plugin' }
          installed.push({ name: def.name, entry })
          variables.set(def.name, entry)
        }
        ctx.emit('variables/changed')
        const remove = (): void => {
          let changed = false
          for (const { name, entry } of installed) {
            // Identity check: only drop names this call still owns (a later
            // re-registration by someone else stays).
            if (variables.get(name) === entry) {
              variables.delete(name)
              changed = true
            }
          }
          if (changed) ctx.emit('variables/changed')
        }
        // Effects take a body producing the disposer; passing `remove`
        // itself would run it as setup.
        caller.effect(() => remove)
        return remove
      },
    })
  },
}

export default variablesPlugin

/**
 * The consume recipe for demand plugins: seed the current value with a
 * `points.read`, then follow `point/updated` increments. Returns `undefined`
 * until the first observation — an unmapped variable stays undefined.
 *
 * The hook manages the wire subscription for its lifetime; the matching
 * `points.unsubscribe` fires on unmount so the host stops broadcasting.
 */
export function usePoint(ctx: Context, id: string): { value: PointValue, time: number } | undefined {
  const [sample, setSample] = useState<{ value: PointValue, time: number } | undefined>(undefined)
  const { link } = (ctx as Context & { client: ClientLink }).client

  useEffect(() => {
    let live = true
    const detach = link.subscribe('point/updated', payload => {
      const frame = payload as { id?: string, value?: PointValue, time?: number }
      if (frame.id !== id || frame.time === undefined) return
      if (live) setSample({ value: frame.value as PointValue, time: frame.time })
    })
    void link.call('points.subscribe', { ids: [id] }).catch(() => {})
    void link.call('points.read', { ids: [id] })
      .then(result => {
        if (!live || !result.ok) return
        const first = result.value.samples[0]
        if (first !== undefined) setSample({ value: first.value, time: first.time })
      })
      .catch(() => {})
    return () => {
      live = false
      detach()
      void link.call('points.unsubscribe', { ids: [id] }).catch(() => {})
    }
  }, [link, id])

  return sample
}
