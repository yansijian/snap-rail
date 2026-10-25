/**
 * Authoring helper for UI packages: define the package's slot vocabulary in
 * one place and get a runtime membership guard for it. A
 * vocabulary is plain data — a `shell.menu`-style dotted id table plus the
 * reserved `custom:<publisher>.<name>` extension namespace — and every
 * consumer (components, layouts) checks membership through the returned
 * guard instead of hand-rolled string tests. Ids are declared with an
 * `as const` object so consumers get autocomplete and compile-time
 * misspelling errors from the literal-union type (`SlotIdOf`).
 *
 * The built-in UI substrate (`@snap-rail/ui`) owns the canonical
 * `UI_SLOT_IDS`/`isValidSlotId` vocabulary; page/layout/skin plugins consume
 * that contract instead of declaring a parallel one.
 *
 * @module @snap-rail/plugin-kit/slot-vocabulary
 */

/** Shape every slot id shares: dotted lowercase kebab (`shell.menu`). */
const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]+)+$/

/** The reserved extension namespace: a custom slot is owned by a publisher. */
export const CUSTOM_SLOT_PATTERN = /^custom:[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/

/** The slot id union of a vocabulary: its declared ids plus `custom:` seats. */
export type SlotIdOf<T extends Record<string, string>> = T[keyof T] | `custom:${string}`

export interface SlotVocabulary<T extends Record<string, string>> {
  /** The frozen id table (e.g. `{ menu: 'shell.menu', titlebar: 'shell.titlebar' }`). */
  readonly ids: T
  /** Membership guard: the declared vocabulary plus `custom:` seats. */
  isSlotId(value: string): value is SlotIdOf<T>
}

/** Define and validate a framework's slot vocabulary. Malformed ids throw at
 * definition time — a vocabulary ships once and is consumed everywhere, so
 * it fails loudly in the framework author's build, never in a component. */
export function defineSlotVocabulary<const T extends Record<string, string>>(
  ids: T,
  options?: { customPattern?: RegExp },
): SlotVocabulary<T> {
  for (const [key, id] of Object.entries(ids)) {
    if (!SLOT_ID_PATTERN.test(id)) {
      throw new Error(`defineSlotVocabulary: 插槽 id 不合法（需为小写 kebab 点分，如 shell.menu）：${key} = ${JSON.stringify(id)}`)
    }
  }
  const known = new Set<string>(Object.values(ids))
  const customPattern = options?.customPattern ?? CUSTOM_SLOT_PATTERN
  return {
    ids,
    isSlotId(value: string): value is SlotIdOf<T> {
      return known.has(value) || customPattern.test(value)
    },
  }
}
