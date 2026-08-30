/**
 * The renderer-occupant package names this app ships — the ONE list both
 * halves of the desktop assembly consume: the host boot keeps these
 * `plugins.yml` rows out of the host tree (`rendererPackages`), and the
 * renderer entry pairs each name with its plugin before mounting. Adding a
 * renderer occupant = one entry here plus one pairing in the client entry
 * (which asserts the two stay in sync).
 *
 * @module @snap-rail/desktop/renderer-packages
 */

export const RENDERER_PACKAGES: readonly string[] = [
  '@snap-rail/layout-station',
  '@snap-rail/chrome-titlebar',
  '@snap-rail/process-maintenance',
  '@snap-rail/process-production',
  '@snap-rail/process-sampling',
  '@snap-rail/process-fault',
  '@snap-rail/process-downtime',
  '@snap-rail/settings-station',
  '@snap-rail/driver-modbus/station',
]
