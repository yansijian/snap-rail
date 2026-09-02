/**
 * The renderer seed table's vocabulary: the module ids a client bundle may
 * `require`. Everything else must be bundled into the plugin. This list is
 * the single source — the shell seeds exactly these ids (by importing them
 * statically), and the plugin-kit's client preset externalizes exactly
 * these ids. Cross-plugin value imports are forbidden (collaboration goes
 * through cordis services and slots); adding an id here is a spine decision.
 *
 * @module @snap-rail/plugin-kit/seeds
 */

/** Module ids the shell seeds and client bundles may require. */
export const SEED_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@snap-rail/cordis',
  '@snap-rail/client-ui',
  '@snap-rail/client-kernel',
  '@snap-rail/client-slots',
  '@snap-rail/client-settings',
  '@snap-rail/client-session',
  '@snap-rail/client-workflows',
  '@snap-rail/client-variables',
  '@snap-rail/client-modules',
  '@snap-rail/connection',
  '@snap-rail/protocol',
  '@snap-rail/station-rpc/contract',
  '@snap-rail/app-boot/contract',
  'zod',
]
