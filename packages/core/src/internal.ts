/**
 * Internal seam — imported ONLY by @runskein/conformance (probe + suites).
 *
 * Not part of the public API surface: anything imported from
 * '@runskein/core/internal' is off the supported path and may change
 * without an API decision note.
 */
export { AcpConnection, withTimeout } from './acp/connection.js';
export type { WireFrame, WireObserver } from './acp/wireTrace.js';
export type {
  AcpConnectionOptions,
  AcpInitializeResult,
  AcpModeState,
  AcpNewSessionResult,
  AcpPromptResult,
} from './acp/connection.js';
export {
  autoAllowPermission,
  type AcpClientHandlers,
  type PermissionHandler,
  type PermissionRequestLike,
  type QuestionRequestLike,
  type QuestionResponseLike,
  type SessionUpdateNotification,
} from './acp/clientMethods.js';
export { TurnQueue } from './session/turnQueue.js';
export { realIdleClock } from './session/idleClock.js';
export type { IdleClock } from './session/idleClock.js';
export { resolveResume } from './session/resume.js';
export type { ResumeContext, ResumeOutcome } from './session/resume.js';
export {
  buildDigest,
  DIGEST_TRUNCATION_MARKER,
  estimateTokens,
  renderDigestSegments,
  renderStructuredDigest,
} from './transcript/digest.js';
export type {
  DigestOptions,
  StructuredDigestOptions,
  TextDigestOptions,
  DigestResult,
} from './transcript/digest.js';
export { jsonlStore } from './transcript/jsonlStore.js';
export { sqliteStore } from './transcript/sqliteStore.js';
export { memoryStore } from './transcript/memoryStore.js';
export type { TranscriptStore, SessionFilter, SessionMeta } from './transcript/store.js';
export type {
  TranscriptEvent,
  TranscriptDigest,
  DigestRole,
  DigestSegment,
  StructuredDigest,
  Usage,
} from './transcript/event.js';
export {
  sessionMetaUpdate,
  readSessionMeta,
  foldUsage,
  syntheticUsageUpdate,
  RUNSKEIN_SESSION_META_KEY,
} from './transcript/event.js';
export { foldSessionMeta, matchesFilter } from './transcript/store.js';
export { decisionToOutcome } from './permission/policy.js';
export {
  normalizeCapabilities,
  applyCapabilityOverride,
  type CapabilityOverride,
  type RawAgentCapabilities,
} from './acp/capabilities.js';
export {
  ENV_SCRUB_PATTERNS,
  scrubEnv,
  spawnEngine,
  stopTree,
  stopTreeByPid,
  onceExit,
} from './process/spawn.js';
export {
  defaultRegistryPath,
  fileOwnershipRegistry,
  isPidAlive,
  identityMatches,
  sweepOrphans,
} from './process/ownership.js';
export type {
  IdentityVerdict,
  OrphanReaper,
  OrphanSweepResult,
  OwnershipEntry,
  OwnershipRegistry,
} from './process/ownership.js';
export type { SpawnedEngine } from './process/spawn.js';
export { SessionTerminals } from './process/terminal.js';
export type { TerminalCreateParams, TerminalExitStatus, TerminalOutput } from './process/terminal.js';
export { HealthMachine, type ProcessHealth } from './process/health.js';
export { ProcessManager } from './process/manager.js';
export type { AcquiredEngine, ProcessManagerOptions } from './process/manager.js';
export { Registry, validateAdapter, ADAPTER_SPEC_VERSION } from './registry.js';
export type { RegistryOptions } from './registry.js';
export { Hub, inspectRouting, type InternalHubOptions } from './hub.js';
