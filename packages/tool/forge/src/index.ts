/**
 * The forge package's host face entry: re-exports the host plugin (the
 * installable zip's `main`) and the wire contract for typed consumers.
 *
 * @module @snap-rail/forge
 */

export { default } from './host.ts'
export {
  FORGE_LLM_KEY,
  forgeContract,
  genMountedSchema,
  genUnmountedSchema,
  llmConfigSchema,
  pluginsChangedSchema,
  sessionDeltaSchema,
} from './contract.ts'
export type {
  GenFace,
  GeneratedPluginInfo,
  GeneratedPluginStatus,
  LlmConfig,
  SessionDelta,
  SessionMessage,
  SessionSummary,
} from './contract.ts'
