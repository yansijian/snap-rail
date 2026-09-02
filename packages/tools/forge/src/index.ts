/**
 * The forge package's host face entry: re-exports the host plugin (the
 * installable zip's `main`) and the wire contract for typed consumers.
 *
 * @module @snap-rail/forge
 */

export { default } from './host.ts'
export {
  FORGE_LLM_KEY,
  forgeRequestSchemas,
  genMountedSchema,
  genUnmountedSchema,
  llmConfigSchema,
  sessionDeltaSchema,
} from './contract.ts'
export type {
  ForgeFaceApi,
  ForgePluginApi,
  ForgeReportApi,
  ForgeSessionApi,
  GenFace,
  GeneratedPluginInfo,
  GeneratedPluginStatus,
  LlmConfig,
  SessionDelta,
  SessionMessage,
  SessionSummary,
} from './contract.ts'
