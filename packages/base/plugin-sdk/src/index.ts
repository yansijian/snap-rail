/**
 * Public plugin authoring surface. This package is intentionally small: it
 * re-exports the stable build and release primitives while keeping plugin
 * authors away from snap-rail's workspace source paths.
 *
 * @module @snap-rail/plugin-sdk
 */

import { z } from 'zod'
import { snapRailManifestSchema } from '@snap-rail/plugin-kit/manifest'
import type { Plugin } from '@snap-rail/cordis'
export type { Context, Plugin } from '@snap-rail/cordis'
export {
  CLIENT_EXTERNALS,
  CONTRIBUTED_SEED_MODULES,
  PLUGIN_KINDS,
  SEED_MODULES,
  clientBundle,
  hostBundle,
  releaseFiles,
  releaseManifest,
  signReleaseFiles,
  signReleaseMetadata,
  verifyReleaseFiles,
  zipFileName,
  type ReleaseFileDigests,
  type ReleaseMetadata,
  type ReleaseSignature,
  type ReleaseSpec,
  type TrustedReleaseKey,
} from '@snap-rail/plugin-kit'
export { snapRailManifestSchema, type SnapRailManifest, type SnapRailManifestInput } from '@snap-rail/plugin-kit/manifest'

/** Complete package manifest shape used by the standalone authoring tool. */
export const pluginPackageSchema = z.object({
  name: z.string().regex(/^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().optional(),
  type: z.literal('module').optional(),
  main: z.string().min(1).optional(),
  snapRail: snapRailManifestSchema,
}).passthrough()
export type PluginPackageManifest = z.output<typeof pluginPackageSchema>

/** Parse a package manifest before a build or release is attempted. */
export function definePluginManifest(value: unknown): PluginPackageManifest {
  return pluginPackageSchema.parse(value)
}

/** Type-safe identity helper for a plugin's Host or Renderer entry. */
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin
}

/** Public plugin template categories used by the standalone CLI. */
export const PLUGIN_TEMPLATES = ['driver', 'store-provider', 'ui-view', 'ui-layout', 'ui-extension', 'host-service', 'tool', 'suite'] as const
export type PluginTemplate = typeof PLUGIN_TEMPLATES[number]
