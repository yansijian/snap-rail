/**
 * The surface vocabulary: one renderer window role. `main` is the operator
 * window (the app's only always-present surface); `ball` and `panel` are the
 * auxiliary always-on-top surfaces a plugin drives through the Shell seam —
 * the floating ball and its mini panel.
 *
 * A surface is an identity, not a layout. Every surface boots the same
 * renderer with its own client entry (`snapRail.client.surfaces`) and its own
 * seed set; a plugin face binds to exactly one surface and reads
 * `ctx.client.surface` to know which. Auxiliary surfaces never subscribe to
 * equipment points directly — they consume host-aggregated frames, because a
 * hidden surface must not keep a data path alive and a shown one must not
 * need a second subscription graph.
 *
 * The whitelist is closed on purpose: a plugin may not name an arbitrary URL
 * or spawn an arbitrary window — the Shell owns every window and only these
 * three roles exist.
 *
 * @module @snap-rail/protocol/surfaces
 */

/** Every surface id, in boot order (`main` first). */
export const SURFACE_IDS = ['main', 'ball', 'panel'] as const

/** The always-on-top auxiliary surfaces: windows the Shell creates lazily. */
export const AUX_SURFACE_IDS = ['ball', 'panel'] as const

/** One renderer window role. */
export type SurfaceId = (typeof SURFACE_IDS)[number]

/** One auxiliary surface role. */
export type AuxSurfaceId = (typeof AUX_SURFACE_IDS)[number]

/**
 * Whether a wire value names a surface.
 *
 * @param value - the candidate (any wire value).
 * @returns true when the value is a {@link SurfaceId}.
 */
export function isSurfaceId(value: unknown): value is SurfaceId {
  return typeof value === 'string' && (SURFACE_IDS as readonly string[]).includes(value)
}

/**
 * Whether a wire value names an auxiliary surface.
 *
 * @param value - the candidate (any wire value).
 * @returns true when the value is an {@link AuxSurfaceId}.
 */
export function isAuxSurfaceId(value: unknown): value is AuxSurfaceId {
  return typeof value === 'string' && (AUX_SURFACE_IDS as readonly string[]).includes(value)
}
