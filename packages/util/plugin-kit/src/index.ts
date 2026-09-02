/**
 * The plugin author's kit: manifest vocabulary, the renderer seed whitelist,
 * the tsdown presets producing installable host + client faces, and the
 * final-format packer assembling the installable zip. A new plugin starts by
 * copying `driver-mock` (host-only) or a suite package and swapping these
 * presets in.
 *
 * @module @snap-rail/plugin-kit
 */

export {
  PLUGIN_KINDS,
  clientFaceSchema,
  snapRailManifestSchema,
  type SnapRailManifest,
  type SnapRailManifestInput,
} from './manifest.ts'
export { SEED_MODULES } from './seeds.ts'
export { clientBundle, hostBundle } from './build.ts'
export { releaseFiles, releaseManifest, zipFileName, type ReleaseSpec } from './pack.ts'
