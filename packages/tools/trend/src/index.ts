/**
 * The trend package's host entry: the whole host face is the plugin below;
 * this re-export keeps the package main stable while the face grows
 * (recorder, engine, watch loop, RPC domain). The wire contract rides
 * `./contract` — the pure face both ends import.
 *
 * @module @snap-rail/trend
 */

export { default } from './host.ts'
export type { TrendConfig } from './host.ts'
