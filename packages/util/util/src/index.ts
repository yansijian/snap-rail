/**
 * Zero-dependency utilities shared across snap-rail packages.
 *
 * @module @snap-rail/util
 */

export * from './manifest.ts'
export * from './clock.ts'

/**
 * Nominal-typing primitive: distinguishes values that share an underlying
 * representation (e.g. point ids vs connection ids, both strings) without
 * runtime cost. The brand property never exists at runtime.
 *
 * @example
 * ```ts
 * export type PointId = Branded<string, 'PointId'>
 * const id: PointId = PointId('p1') // mint through a validating constructor
 * ```
 */
export type Branded<T, B extends string> = T & { readonly __brand: B }

/**
 * Assert that a discriminated-union switch exhausted every case.
 *
 * @param value The narrowed-to-`never` value at the default branch.
 * @param context Label for the error message naming what was unexpected.
 * @returns Never; always throws.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`assertNever: unexpected ${context}: ${JSON.stringify(value)}`)
}
