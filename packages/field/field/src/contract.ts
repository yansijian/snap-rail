/**
 * The field domain's pure contract face: the wire rows/schemas that merge
 * into the protocol maps, plus the model types and helpers. Everything
 * reachable here is client-safe by construction (zod + types only) —
 * renderer faces consume the base through this subpath, and the node side
 * (store/drizzle) stays behind the package main.
 *
 * @module @snap-rail/field/contract
 */

export * from './wire.ts'
export * from './model.ts'
export * from './mapping.ts'
