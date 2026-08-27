/**
 * @runskein/core — public surface.
 *
 * Consumers normally import the `runskein` meta-package instead: its
 * createHub bundles the built-in adapters. Nothing exported here leaks
 * `@agentclientprotocol/sdk`: ACP stays confined to `src/acp/`.
 */
export { createHub, Hub } from './hub.js';
export { Session } from './session/session.js';
export type {
  TurnResult,
  QuestionRequest,
  Answer,
  ReactivationInfo,
  CloseOptions,
} from './session/session.js';
export type { SessionConfigState, ConfigObservation } from './session/configState.js';
export { policies } from './permission/policy.js';
export type {
  PermissionPolicy,
  PermissionRequest,
  PermissionDecision,
  PermissionRule,
} from './permission/policy.js';
export { jsonlStore } from './transcript/jsonlStore.js';
export { sqliteStore } from './transcript/sqliteStore.js';
export { memoryStore } from './transcript/memoryStore.js';
export type { ResumeTier } from './session/session.js';
export type {
  TranscriptEvent,
  Usage,
  UsageSummary,
  TranscriptDigest,
  DigestRole,
  DigestSegment,
  StructuredDigest,
  SessionStatus,
} from './transcript/event.js';
export { isPromptEcho } from './transcript/event.js';
export type { TranscriptStore, SessionMeta, SessionFilter } from './transcript/store.js';
export { estimateTokens, renderDigestSegments, renderStructuredDigest } from './transcript/digest.js';
export type {
  DigestOptions,
  StructuredDigestOptions,
  TextDigestOptions,
  DigestResult,
} from './transcript/digest.js';
export type {
  ContentBlock,
  SessionUpdate,
  ToolKind,
  ToolCallLocation,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallStatus,
  PlanEntry,
  PermissionOption,
  PermissionOptionKind,
  McpServerConfig,
  StopReason,
  Annotations,
} from './vocabulary.js';
export {
  NotSupportedError,
  NotInstalledError,
  UnauthenticatedError,
  NotFoundError,
  EngineStartError,
  StoreError,
  EngineCrashError,
  CancelledError,
  ConfigError,
  EngineOperationError,
} from './errors.js';
export type { EngineErrorKind } from './errors.js';
export type {
  Health,
  SelectOption,
  SelectGroup,
  ConfigOption,
  ConfigSchema,
  SessionMode,
  SessionModel,
  ProviderInfo,
  CapabilityMatrix,
  RegisteredEngineInfo,
  InvalidEngineInfo,
  EngineInfo,
  EngineDescriptor,
  DetectResult,
  EngineErrorPattern,
  EngineAdapter,
  HubOptions,
  SessionOpts,
  Unsubscribe,
  HubEvent,
  EngineCrashInfo,
} from './types.js';
