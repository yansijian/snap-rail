/**
 * The plugin author's manifest vocabulary: the `snapRail` field of a plugin
 * package's `package.json`. One source of truth for the shape — the
 * installer validates against it, the pool scan records it, and authors
 * import the types.
 *
 * @module @snap-rail/plugin-kit/manifest
 */

import { z } from 'zod'

/** Plugin package kinds. `suite` rows are mutually exclusive on enable. */
export const PLUGIN_KINDS = ['suite', 'driver', 'plugin'] as const

/** The renderer face declaration: where the client bundle lives. */
export const clientFaceSchema = z.object({
  /** Path of the CJS factory bundle inside the package (from its root). */
  entry: z.string().min(1).default('lib/client.js'),
}).strict()

/** The `snapRail` manifest field's schema. */
export const snapRailManifestSchema = z.object({
  /** Role declaration; `suite` packages are single-active. */
  kind: z.enum(PLUGIN_KINDS).optional(),
  /** The renderer face; omit for host-only plugins. */
  client: clientFaceSchema.optional(),
  /** Permission declarations — shown at install time, enforced later. */
  permissions: z.array(z.string()).optional(),
}).strict()

/** The validated manifest field. */
export type SnapRailManifestInput = z.input<typeof snapRailManifestSchema>
export type SnapRailManifest = z.output<typeof snapRailManifestSchema>
