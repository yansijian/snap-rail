/**
 * The variable seam: demand plugins declare the process variables they
 * listen to — a device, a group, a name, and a semantic type, nothing
 * protocol-specific — and mapping surfaces (a driver's settings page) list
 * the registry to wire those declarations onto real register addresses.
 * Point names are unique only within their group, so a declaration is
 * itself the full address — the same (device, group, name) triple the field
 * seam speaks natively; consumers ride the `field/point-update` topic with
 * no id munging.
 *
 * Bindings (below the registry) generalize consumption: a page addresses
 * field data as a device-qualified point (`{device, group, name}`) or a
 * device's whole business group (`{device, group}`) and gets a live
 * aggregated view (any member active ⇒ the group is active with the member
 * names). Group membership is mapping configuration served by the field
 * seam's generic mapping document (`field.mappings.list`, dialect-free), so
 * a `field/mappings-changed` topic re-resolves the binding in place.
 *
 * @module @snap-rail/client-variables
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { subscribeTopic, type HostLink } from '@snap-rail/connection'
import {
  fieldFrameSchemas,
  pointKey,
  type MappingDocument,
  type PointRef,
  type PointType,
  type PointValue,
} from '@snap-rail/field/contract'
import { useEffect, useState } from 'react'

/** The slice of `ctx.client` this package needs; typed locally so the
 * variables package never references the runtime project (a reference
 * cycle: the runtime mounts this plugin). */
interface ClientLink {
  link: HostLink
}

/** What one demand plugin contributes: the variable it wants to hear about,
 * addressed by its full triple. */
export interface VariableDef {
  /** The device the variable lives on. */
  device: string
  /** The business group the variable lives in. */
  group: string
  /** Point name within the group (unique there, not globally). */
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
   * The (device, group, name) triple is the uniqueness contract: a
   * same-address re-registration replaces the earlier one.
   * @param caller - owning context; unload drops every def in the call.
   * @param defs - the declarations; duplicate addresses inside one call throw.
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
        const keys = defs.map(def => pointKey(def))
        if (new Set(keys).size !== keys.length) {
          throw new Error(`variables: duplicate addresses in one registration: ${keys.join(', ')}`)
        }
        const installed: Array<{ key: string, entry: VariableEntry }> = []
        for (const def of defs) {
          const entry: VariableEntry = { ...def, source: 'plugin' }
          const key = pointKey(def)
          installed.push({ key, entry })
          variables.set(key, entry)
        }
        ctx.emit('variables/changed')
        const remove = (): void => {
          let changed = false
          for (const { key, entry } of installed) {
            // Identity check: only drop addresses this call still owns (a
            // later re-registration by someone else stays).
            if (variables.get(key) === entry) {
              variables.delete(key)
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

/** How a demand page addresses field data: one device-qualified point or a
 * device's whole business group. The triple is mandatory — point names are
 * group-scoped, so a bare name cannot address anything. */
export type FieldBinding =
  | { device: string, group: string, name: string }
  | { device: string, group: string }

/** One resolved group member: its field address plus display name. */
export interface ResolvedMember {
  ref: PointRef
  name: string
}

/** A binding after resolution against the mapping document. */
export type ResolvedBinding =
  | { kind: 'point', ref: PointRef, name: string }
  | { kind: 'group', device: string, group: string, members: readonly ResolvedMember[] }

/**
 * Resolve a binding against the generic mapping document. The device must
 * exist, the group entity must exist on it, and the point form must find
 * the point in exactly that group — an unknown group name must read as
 * unresolved, never as "all normal". A group resolves with at least one
 * member, in the document's order (the driver's projection defines it; the
 * first active member is a stable "primary").
 */
export function resolveBinding(doc: MappingDocument, binding: FieldBinding): ResolvedBinding | undefined {
  if (!doc.devices.some(device => device.id === binding.device)) return undefined
  if (!doc.groups.some(group => group.deviceId === binding.device && group.name === binding.group)) return undefined
  if ('name' in binding) {
    const mapped = doc.points.some(point =>
      point.deviceId === binding.device && point.group === binding.group && point.name === binding.name)
    if (!mapped) return undefined
    return {
      kind: 'point',
      ref: { device: binding.device, group: binding.group, name: binding.name },
      name: binding.name,
    }
  }
  const members = doc.points
    .filter(point => point.deviceId === binding.device && point.group === binding.group)
    .map(point => ({ ref: { device: point.deviceId, group: point.group, name: point.name }, name: point.name }))
  if (members.length === 0) return undefined
  return { kind: 'group', device: binding.device, group: binding.group, members }
}

/** Any-active truthiness: `true`, a nonzero number/bigint, a non-empty string. */
function isActiveValue(value: PointValue): boolean {
  if (value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number') return value !== 0
  return value.length > 0
}

/** One active group member with the sample that activated it. */
export interface BoundMember {
  /** The point name — the business name a group view surfaces. */
  name: string
  value: PointValue
  time: number
}

/** The live view of a binding a listener receives. */
export type BindingView =
  | { kind: 'unresolved' }
  | { kind: 'point', ref: PointRef, name: string, sample: { value: PointValue, time: number } | undefined }
  | {
      kind: 'group'
      device: string
      group: string
      /** `active` when any member is truthy; `normal` otherwise. */
      status: 'normal' | 'active'
      /** Active members in group display order (see `resolveBinding`). */
      active: readonly BoundMember[]
      /** Members whose latest sample is `null` (link abnormal after observing). */
      abnormal: readonly string[]
      /** Mapped members with no observation yet. */
      pending: readonly string[]
    }

/**
 * Watch one binding and emit a `BindingView` on every change. The watcher
 * resolves the generic mapping document itself, seeds current values with
 * one `field.points.read`, follows the `field/point-update` topic, and
 * re-resolves on a `field/mappings-changed` publication — re-mapping takes
 * effect without remounting the consumer.
 *
 * The returned stop function closes this watcher's topic gate; overlapping
 * watchers each hold their own and never starve each other.
 */
export function watchBinding(
  ctx: Context,
  binding: FieldBinding,
  listener: (view: BindingView) => void,
): () => void {
  const { link } = (ctx as Context & { client: ClientLink }).client
  let live = true
  let resolved: ResolvedBinding | undefined
  let refs: readonly PointRef[] = []
  const samples = new Map<string, { value: PointValue, time: number }>()

  const compute = (): void => {
    if (resolved === undefined) {
      listener({ kind: 'unresolved' })
      return
    }
    if (resolved.kind === 'point') {
      listener({ kind: 'point', ref: resolved.ref, name: resolved.name, sample: samples.get(pointKey(resolved.ref)) })
      return
    }
    const active: BoundMember[] = []
    const abnormal: string[] = []
    const pending: string[] = []
    for (const member of resolved.members) {
      const sample = samples.get(pointKey(member.ref))
      // `null` with `time` 0 is the field seam's "registered but never
      // observed" read; a `null` with a real timestamp is link abnormal.
      if (sample === undefined || (sample.value === null && sample.time === 0)) pending.push(member.name)
      else if (sample.value === null) abnormal.push(member.name)
      else if (isActiveValue(sample.value)) active.push({ name: member.name, value: sample.value, time: sample.time })
    }
    listener({
      kind: 'group',
      device: resolved.device,
      group: resolved.group,
      status: active.length > 0 ? 'active' : 'normal',
      active,
      abnormal,
      pending,
    })
  }

  const resubscribe = (): void => {
    void link.call('field.mappings.list', {})
      .then(result => {
        if (!live || !result.ok) return
        const next = resolveBinding(result.value.mappings, binding)
        const nextRefs = next === undefined ? [] : next.kind === 'point' ? [next.ref] : next.members.map(member => member.ref)
        refs = nextRefs
        resolved = next
        samples.clear()
        if (nextRefs.length === 0) {
          compute()
          return
        }
        void link.call('field.points.read', { points: [...nextRefs] })
          .then(read => {
            if (!live) return
            if (read.ok) {
              for (const sample of read.value.samples) {
                samples.set(pointKey(sample), { value: sample.value, time: sample.time })
              }
            }
            // A read mixing registered and unregistered addresses fails
            // wholesale (not-found); compute anyway — the missing members
            // simply read as pending until the rig catches up.
            compute()
          })
          .catch(() => {
            // The call itself failed (carrier); the view observes nothing yet.
            if (live) compute()
          })
      })
      .catch(() => {})
  }

  const detachUpdates = subscribeTopic(link, 'field/point-update', undefined, fieldFrameSchemas['field/point-update'], frame => {
    const ref: PointRef = { device: frame.device, group: frame.group, name: frame.name }
    if (!refs.some(current => pointKey(current) === pointKey(ref))) return
    samples.set(pointKey(ref), { value: frame.value, time: frame.time })
    compute()
  })
  const detachConfig = subscribeTopic(link, 'field/mappings-changed', undefined, fieldFrameSchemas['field/mappings-changed'], () => { resubscribe() })

  resubscribe()

  return () => {
    live = false
    detachUpdates()
    detachConfig()
  }
}

/** Stable identity of a binding for hook dependency lists. */
function bindingKey(binding: FieldBinding): string {
  return 'name' in binding
    ? `${binding.device}/${binding.group}/${binding.name}`
    : `${binding.device}/${binding.group}`
}

/** The React recipe over `watchBinding`; `unresolved` until first observation. */
export function useBinding(ctx: Context, binding: FieldBinding): BindingView {
  const [view, setView] = useState<BindingView>({ kind: 'unresolved' })
  const { link } = (ctx as Context & { client: ClientLink }).client
  const key = bindingKey(binding)
  useEffect(() => watchBinding(ctx, binding, setView), [link, key])
  return view
}

/**
 * The consume recipe for demand plugins: seed the current value with a
 * `field.points.read`, then follow `field/point-update` publications. Returns
 * `undefined` until the first observation — an unmapped declaration stays
 * undefined.
 *
 * The hook holds one topic gate for its lifetime; the matching unsubscribe
 * fires on unmount.
 */
export function usePoint(
  ctx: Context,
  binding: { device: string, group: string, name: string },
): { value: PointValue, time: number } | undefined {
  const [sample, setSample] = useState<{ value: PointValue, time: number } | undefined>(undefined)
  const { link } = (ctx as Context & { client: ClientLink }).client
  const key = pointKey(binding)

  useEffect(() => {
    let live = true
    const detach = subscribeTopic(link, 'field/point-update', { points: [binding] }, fieldFrameSchemas['field/point-update'], frame => {
      const frameRef: PointRef = { device: frame.device, group: frame.group, name: frame.name }
      if (pointKey(frameRef) !== key) return
      if (live) setSample({ value: frame.value, time: frame.time })
    })
    void link.call('field.points.read', { points: [binding] })
      .then(result => {
        if (!live || !result.ok) return
        const first = result.value.samples[0]
        if (first !== undefined) setSample({ value: first.value, time: first.time })
      })
      .catch(() => {})
    return () => {
      live = false
      detach()
    }
  }, [link, key])

  return sample
}
