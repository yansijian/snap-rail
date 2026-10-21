/**
 * Which bundle a plugin row contributes to which window — the rule the
 * renderer's loader runs for every row, lifted out of the React boot so it can
 * be tested on its own.
 *
 * One package ships one bundle per window: the main window's bundle is the
 * package's `client.entry` (module id = the package name), and each auxiliary
 * window's bundle is a `client.surfaces` entry (module id =
 * `<package>/<surface>`). Seeds are the exception: a **seed provider** (the UI
 * framework, a contract owner) loads in every window from its main bundle,
 * because its contributed modules and its styling are what every face —
 * including a ball face — requires.
 *
 * @module @snap-rail/desktop/client-surface-faces
 */

import type { SurfaceId } from '@snap-rail/protocol'
import type { ClientConfigRow } from '@snap-rail/station-rpc/contract'

/** The bundle a row contributes here, and the module id it registers under. */
export interface SurfaceFace {
  /** The URL the window fetches and executes. */
  url: string
  /** The module id the bundle registers under. */
  moduleId: string
}

/**
 * The bundle a row contributes to one surface.
 *
 * @param row - the renderer's row (bundle URLs plus manifest markers).
 * @param surface - the window asking.
 * @returns the bundle to load, or `undefined` when the row has no face here.
 */
export function faceFor(row: ClientConfigRow, surface: SurfaceId): SurfaceFace | undefined {
  if (surface === 'main') {
    return row.clientUrl === undefined ? undefined : { url: row.clientUrl, moduleId: row.name }
  }
  const url = row.surfaceUrls?.[surface]
  return url === undefined ? undefined : { url, moduleId: `${row.name}/${surface}` }
}

/**
 * Whether a row's face must load in this window even without contributing a
 * bundle here: the framework (its runtime, theme, and settings shell) and every
 * seed provider (the framework's primitives, a contract owner's exported face).
 *
 * @param row - the renderer's row.
 * @returns true when the row's main bundle loads on every surface.
 */
export function isSeedProvider(row: ClientConfigRow): boolean {
  return row.kind === 'framework' || (row.seeds?.length ?? 0) > 0
}

/**
 * The bundle one row contributes to one window, including the seed-provider
 * rule: a provider falls back to its main bundle, everything else contributes
 * only its own face.
 *
 * @param row - the renderer's row.
 * @param surface - the window asking.
 * @returns the bundle to load, or `undefined` when this row is unrelated to this window.
 */
export function plannedFace(row: ClientConfigRow, surface: SurfaceId): SurfaceFace | undefined {
  const own = faceFor(row, surface)
  if (own !== undefined) return own
  if (!isSeedProvider(row) || row.clientUrl === undefined) return undefined
  return { url: row.clientUrl, moduleId: row.name }
}