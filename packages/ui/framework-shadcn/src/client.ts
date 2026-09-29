/**
 * The framework's installable client face: one bundle carrying every face —
 * the runtime, the slot registry, the shared primitives, the client
 * services, and the fallback layout — re-exported as the contributed-seed
 * map. The shell requires this face once and seeds each
 * `@snap-rail/framework-shadcn/<key>` id from the map, so every installed
 * component shares these exact instances (one slots registry, one primitives
 * set, one runtime entry).
 *
 * @module @snap-rail/framework-shadcn/client
 */

import * as fallback from './fallback.tsx'
import * as runtime from './runtime.tsx'
import * as session from './session.ts'
import * as settingsPages from './settings-pages.ts'
import * as slots from './slots.tsx'
import * as semantic from './semantic.tsx'
import * as ui from './ui/index.ts'
import * as variables from './variables.ts'
import * as workflows from './workflows.ts'

/** The faces this framework contributes as shared seeds. */
export interface FrameworkSeedFaces {
  ui: typeof ui
  slots: typeof slots
  semantic: typeof semantic
  'settings-pages': typeof settingsPages
  session: typeof session
  variables: typeof variables
  workflows: typeof workflows
  runtime: typeof runtime
  fallback: typeof fallback
}

/**
 * The client-face default export: the contributed-seed map. No plugin
 * object rides along — the framework mounts nothing into an occupant seat;
 * the runtime face's `createClientRuntime` is the integration point.
 */
const frameworkClientFace: { seeds: FrameworkSeedFaces } = {
  seeds: {
    ui,
    slots,
    semantic,
    'settings-pages': settingsPages,
    session,
    variables,
    workflows,
    runtime,
    fallback,
  },
}

export default frameworkClientFace
