/**
 * runskein — the consumer entry point:
 * `import { createHub } from 'runskein'` gets @runskein/core's public
 * surface with the built-in adapters bundled as the discovery base
 * layer (static imports, so bundlers work — the built-in layer).
 *
 * Presentation-side folding is deliberately NOT here: it is a different layer
 * with different guarantees, and it lives on `runskein/fold`.
 */
import opencode from '@runskein/adapter-opencode';
import kimi from '@runskein/adapter-kimi';
import claudeCode from '@runskein/adapter-claude-code';
import codex from '@runskein/adapter-codex';
import pi from '@runskein/adapter-pi';
import { Hub, type InternalHubOptions } from '@runskein/core/internal';
import type { EngineAdapter, HubOptions } from '@runskein/core';

/** The adapters bundled with this package (workspace/installed override by id). */
export const builtinAdapters: readonly EngineAdapter[] = [opencode, kimi, claudeCode, codex, pi];

/**
 * createHub with the built-in adapters pre-registered.
 *
 * The built-ins are registered unconditionally, and neither option here
 * narrows that set. `discovery` opts into *dynamic* discovery — scanning
 * workspace and installed adapter packages — and is off by default because
 * importing an adapter executes code with host privileges; it says nothing
 * about the built-ins. Explicit `adapters` are added alongside them, replacing
 * only a built-in that shares an `id`, so passing one adapter of your own
 * yields every built-in plus yours rather than yours alone.
 *
 * For a hub holding only the adapters you name, construct the `Hub` this
 * package re-exports: `new Hub({ adapters: [...] })` registers no built-ins at
 * all.
 *
 * @param options - HubOptions; the built-in adapters are always the discovery
 *   base layer, and `discovery` governs only the layers above them.
 * @returns a Hub with the built-in adapters pre-registered.
 */
export function createHub(options: HubOptions = {}): Hub {
  return new Hub({ ...options, builtins: [...builtinAdapters] } satisfies InternalHubOptions);
}

// ── @runskein/core public surface, re-exported verbatim ──────────────────
export {
  Hub,
  Session,
  policies,
  jsonlStore,
  sqliteStore,
  memoryStore,
  estimateTokens,
  renderDigestSegments,
  renderStructuredDigest,
  isPromptEcho,
} from '@runskein/core';
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
} from '@runskein/core';
export type {
  TurnResult,
  QuestionRequest,
  Answer,
  CloseOptions,
  SessionConfigState,
  ConfigObservation,
  ReactivationInfo,
  PermissionPolicy,
  PermissionRequest,
  PermissionDecision,
  PermissionRule,
  ResumeTier,
  TranscriptEvent,
  Usage,
  UsageSummary,
  TranscriptDigest,
  DigestRole,
  DigestSegment,
  StructuredDigest,
  DigestOptions,
  StructuredDigestOptions,
  TextDigestOptions,
  DigestResult,
  SessionStatus,
  TranscriptStore,
  SessionMeta,
  SessionFilter,
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
  EngineErrorKind,
  EngineErrorPattern,
  EngineAdapter,
  UsageMapping,
  UsageTokenKey,
  HubOptions,
  SessionOpts,
  Unsubscribe,
  HubEvent,
  EngineCrashInfo,
} from '@runskein/core';
