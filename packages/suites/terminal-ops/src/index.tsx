/**
 * The terminal-ops business suite (业务套件): one scenario's whole renderer
 * face — the station layout (login gate + workflow rail + content area), the
 * window chrome (operator chip, settings entry, window controls), the five
 * process pages (维护/生产/抽检/故障/停机), and the production counting
 * settings page. One package, one loader row, one toggle: a suite is enabled,
 * disabled, or discarded as a whole; its members are strong-coupled by
 * design (the sampling page requires the production page's action constants)
 * and that coupling lives inside this package, never across package edges.
 *
 * The host-side face is `./stats` (the shift counter). This package declares
 * `snapRail.kind = 'suite'`: activating it deactivates any other suite
 * (industrial terminals serve one scenario at a time).
 *
 * @module @snap-rail/suite-terminal-ops
 */

import { type Plugin } from '@snap-rail/cordis'
import { z } from 'zod'
import chromePlugin from './chrome.tsx'
import downtimePlugin from './downtime.tsx'
import faultPlugin, { faultConfigSchema } from './fault.tsx'
import layoutPlugin from './layout.tsx'
import maintenancePlugin from './maintenance.tsx'
import productionPlugin, { productionConfigSchema } from './production.tsx'
import samplingPlugin, { samplingConfigSchema } from './sampling.tsx'

/** The suite's config fans out to the members that take one; each member's
 * own schema applies its defaults when the suite row omits the section. */
export const suiteConfigSchema = z.object({
  production: productionConfigSchema.optional(),
  sampling: samplingConfigSchema.optional(),
  fault: faultConfigSchema.optional(),
}).strict()

export type SuiteConfig = z.infer<typeof suiteConfigSchema>

/** The suite's renderer face: mounts every member plugin as a child fiber. */
const suitePlugin: Plugin.Object<SuiteConfig> = {
  name: 'suite-terminal-ops',
  Config: suiteConfigSchema,
  apply(ctx, config) {
    ctx.plugin(layoutPlugin)
    ctx.plugin(chromePlugin)
    ctx.plugin(maintenancePlugin)
    ctx.plugin(productionPlugin, productionConfigSchema.parse(config.production ?? {}))
    ctx.plugin(samplingPlugin, samplingConfigSchema.parse(config.sampling ?? {}))
    ctx.plugin(faultPlugin, faultConfigSchema.parse(config.fault ?? {}))
    ctx.plugin(downtimePlugin)
  },
}

export default suitePlugin
export { MAINTENANCE_COMPLETE } from './maintenance.tsx'
export { PRODUCTION_START, PRODUCTION_STOP } from './production.tsx'
