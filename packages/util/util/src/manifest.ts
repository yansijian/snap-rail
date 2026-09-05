/**
 * Repo governance lists — the single source of truth for what is spine,
 * what is an occupant, and how the spine's runtime pieces are addressed.
 * `scripts/verify-spine.ts` and the docs read this module; never re-list
 * these anywhere else. Wire-domain allocation is NOT listed here: domains
 * are claimed at runtime through `ctx.rpc.claimDomain` (first-wins), and
 * `rpc.describe` reports the live claims.
 *
 * @module @snap-rail/util/manifest
 */

/**
 * Spine package directories relative to the repo root (`dir/*` expands to
 * every package under the group). The spine extends itself; occupants
 * extend the spine.
 */
export const SPINE_PACKAGE_DIRS: readonly string[] = [
  'vendor/*',
  'packages/util/util',
  'packages/settings/settings',
  'packages/store/store',
  'packages/audit/audit',
  'packages/boot/app-boot',
  'packages/boot/station-rpc',
  'packages/protocol/*',
  'packages/field/field',
  'packages/client/ui',
  'packages/client/kernel',
  'packages/client/slots',
  'packages/client/settings',
  'packages/client/variables',
  'packages/client/session',
  'packages/client/workflows',
  'packages/client/runtime',
  'packages/client/modules',
  'packages/client/fallback',
]

/**
 * Occupant package names — business plugins the spine must never import.
 * The wire method/frame domains these packages claim are their own; the
 * import direction is what this list guards.
 */
export const OCCUPANT_PACKAGES: readonly string[] = [
  '@snap-rail/suite-terminal-ops',
  '@snap-rail/settings-station',
  '@snap-rail/driver-mock',
  '@snap-rail/driver-modbus',
  '@snap-rail/forge',
  '@snap-rail/trend',
]
