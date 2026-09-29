/**
 * The plugin author's kit: manifest vocabulary, the renderer seed whitelist,
 * the tsdown presets producing installable host + client faces, and the
 * final-format packer assembling the installable zip. A new plugin starts by
 * copying `driver-modbus` (host-only) or a suite package and swapping these
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
export { CLIENT_EXTERNALS, CONTRIBUTED_SEED_MODULES } from './seeds.ts'
export { clientBundle, hostBundle } from './build.ts'
export {
  CUSTOM_SLOT_PATTERN,
  defineSlotVocabulary,
  type SlotIdOf,
  type SlotVocabulary,
} from './slot-vocabulary.ts'
export { releaseFiles, releaseManifest, zipFileName, type ReleaseSpec } from './pack.ts'
export {
  RELEASE_METADATA_PATH,
  RELEASE_SIGNATURE_PATH,
  canonicalJson,
  releaseMetadata,
  sha256,
  signReleaseFiles,
  signReleaseMetadata,
  verifyReleaseFiles,
  type ReleaseFileDigests,
  type ReleaseMetadata,
  type ReleaseSignature,
  type TrustedReleaseKey,
} from './sign.ts'
