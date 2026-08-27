/**
 * Public runskein-owned types — structural mirrors of the frozen v1 surface.
 * Nothing here imports or re-exports from `@agentclientprotocol/sdk`: the
 * protocol stays confined to `src/acp/`, so consumers never depend on it.
 *
 * Engine inventory, adapters, capability matrix, descriptor, hub/session
 * options. Session/transcript/permission classes live in their own modules.
 */
import type { PermissionPolicy } from './permission/policy.js';
import type { TranscriptStore } from './transcript/store.js';
import type { UsageMapping } from './transcript/event.js';
import type { McpServerConfig } from './vocabulary.js';
export type { UsageMapping, UsageTokenKey } from './transcript/event.js';

// ── Health ─────────────────────────────────────

export type Health =
  'stopped' | 'ready' | 'starting' | 'degraded' | 'dead' | 'invalid' | 'not-installed' | 'unauthenticated';

// ── Config vocabulary ────────────────────────────────────────

export interface SelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface SelectGroup {
  name: string;
  options: SelectOption[];
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | (string & {});
  type: 'select' | 'boolean';
  options?: SelectOption[] | SelectGroup[]; // for type: 'select'
  currentValue?: string | boolean;
  /**
   * When this option can be written. Absent means `'session'`: at creation and
   * any time after, which is what every engine-advertised option supports.
   *
   * `'creation'` marks an option an engine only accepts as part of creating the
   * session. `setConfig()` refuses it with a typed error; `session({config})`
   * carries it on the creation request. Describing this is the point: a host
   * renders a one-time choice rather than a live control, instead of
   * discovering the difference from a failed write.
   */
  settable?: 'session' | 'creation';
}

export type ConfigSchema = ConfigOption[];

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

/**
 * A model the engine offers for a session, as advertised at session creation.
 * Reported separately from configOptions because engines expose model choice on
 * its own protocol surface. An engine may publish both; where it does, the
 * config option is the one `setConfig({model})` writes.
 */
export interface SessionModel {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderInfo {
  id: string;
  protocols: string[];
  required: boolean;
  current?: { apiType: string; baseUrl: string };
  metadata?: Record<string, unknown>;
}

// ── Capability matrix ────────────────────────────────────────

export interface CapabilityMatrix {
  loadSession: boolean;
  session: Record<string, boolean>; // resume/fork/list/close/... normalized
  prompt: Record<string, boolean>; // image/audio/embeddedContext/...
  mcp: Record<string, boolean>; // http/sse/...
  providers: boolean;
}

// ── Engine inventory ───────────────────────────

export interface RegisteredEngineInfo {
  id: string;
  installed: boolean;
  version?: string;
  authenticated?: boolean; // from detect(); undefined = unknown
  health: Exclude<Health, 'invalid'>;
  error?: never;
  configHints?: ConfigSchema; // static fallback from the adapter
}

export interface InvalidEngineInfo {
  id?: string; // absent when unrecoverable from the candidate
  installed?: false;
  health: 'invalid';
  error: string;
}

export type EngineInfo = RegisteredEngineInfo | InvalidEngineInfo;

// ── Descriptor ───────────────────────────────────────────────

export interface EngineDescriptor {
  capabilities: CapabilityMatrix;
  providers?: ProviderInfo[];
  modes?: SessionMode[];
  /** Models the engine offers, when it advertises them at session creation. */
  models?: SessionModel[];
  /**
   * The model a fresh session starts on, as observed by the capability probe.
   * Advisory: it is captured from the probe's throwaway session and cached with
   * the rest of the descriptor, so it can lag a later change to the engine's
   * default. Read a live session's model from the engine, not from here.
   */
  currentModel?: string;
  configOptions: ConfigOption[];
  source: 'probe' | 'hints'; // live truth vs adapter configHints fallback
}

// ── Adapters ───────────────────────────────────────────────────

export interface DetectResult {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  loginHint?: string;
}

/** Adapter-owned wording that core may classify at an ACP error boundary. */
export interface EngineErrorPattern {
  cause: 'auth' | 'rate-limit' | 'context' | 'internal';
  /** Regular-expression source, stored as data so adapters survive JSON round-trips. */
  match: string;
  /** JavaScript regular-expression flags. Defaults to case-insensitive matching. */
  flags?: string;
}

export interface EngineAdapter {
  specVersion: 1; // adapter-spec version; gate for loading
  id: string; // === directory name; unique
  launch: {
    command: string; // e.g. 'kimi'
    args?: string[]; // e.g. ['acp']
    env?: Record<string, string>; // applied AFTER core's env scrub
    startTimeoutMs?: number; // npx wrappers need generous budgets
  };
  shim?: string; // entry point for engines that cannot speak the protocol directly
  /**
   * Launch this engine behind a parent-death watchdog.
   *
   * Only for engines that do not exit when their stdin closes: those leak a
   * process every time a host dies uncleanly, because engines run in their own
   * process group and nothing else ties their lifetime to the host's. The
   * watchdog is not a protocol shim — the engine keeps the host's own stdio, so
   * no ACP traffic passes through it. Default false.
   */
  supervise?: boolean;
  detect?: () => Promise<DetectResult>;
  configHints?: ConfigSchema;
  /**
   * Config an engine takes only while its session is being created, declared
   * as data.
   *
   * Some engines carry settings that never reach ACP's config surface. The
   * claude-code wrapper reads `session/new`'s `_meta` once, inside its own
   * session construction, and nothing afterwards can change what it read.
   * runskein delivers such a key on the creation request and reports it through
   * `describe()` as `settable: 'creation'`.
   *
   * Keyed by runskein config key (`reasoning`, `model`, …). `meta` is the path
   * within the creation request's `_meta` object; `values` maps runskein's levels
   * onto whatever the engine expects, because "what high means" is the
   * adapter's knowledge, not core's.
   */
  creationConfig?: Record<
    string,
    {
      meta: string[];
      values: Record<string, string | number | boolean>;
      description?: string;
    }
  >;
  envScrubExtra?: RegExp[];
  /** Adapter-owned error wording; update it only with recorded live-engine evidence. */
  errorPatterns?: EngineErrorPattern[];
  /**
   * Where this engine's usage accounting lives, declared as data so core's one
   * interpreter never branches on an engine id. Absent means the default:
   * token-bearing `usage_update` notifications with cumulative semantics,
   * exactly the pre-declaration behaviour. See decision 033.
   */
  usage?: UsageMapping;
}

// ── Hub options + session options ──────────────────────────────

export interface HubOptions {
  /** Explicit adapter objects — highest priority (tests, embedding). */
  adapters?: EngineAdapter[];
  /** Extra directories to scan for adapter packages. */
  adapterPaths?: string[];
  /** Execute and auto-discover adapters in standard locations. Default false. */
  discovery?: boolean;
  /** Transcript persistence. Default: jsonlStore('.transcripts'). */
  store?: TranscriptStore;
  defaults?: {
    /** Session permission policy default. Default: policies.allowAll. */
    permissionPolicy?: PermissionPolicy;
    /** Idle process reap delay. Default 300 000 ms. */
    idleTimeoutMs?: number;
    /**
     * How long a session may sit idle before it releases its engine reference.
     * Disabled when absent, which keeps a session pinned to its engine for its
     * whole life as before.
     *
     * Distinct from `idleTimeoutMs`: this one decides when a *session* lets go,
     * and the process reap clock only starts once the last reference is gone.
     * The next prompt re-acquires and resumes transparently on the same
     * `Session` object.
     */
    sessionIdleTimeoutMs?: number;
    /**
     * How many times one reactivation episode may retry before giving up.
     * Positive integer, default 3.
     *
     * Separate budget from the process manager's restart attempts: this counts
     * session rebuilds, and one attempt performs at most one engine acquire,
     * which may reuse a healthy process and spawn nothing.
     */
    reactivationAttempts?: number;
    /**
     * Ceiling for setup-class requests — session creation, resume, fork, config
     * writes, close. Default 30 000 ms, which is what the connection layer has
     * always applied.
     */
    requestTimeoutMs?: number;
    /**
     * Ceiling for a single turn (`session/prompt`).
     *
     * **No default: prompts are unbounded unless this is set.** A legitimate
     * turn can run for many minutes, so any number runskein invented here would be
     * a new failure mode rather than a fix. Set it when an unattended host needs
     * a wedged turn to fail instead of hanging forever.
     */
    turnTimeoutMs?: number;
  };
}

export interface SessionOpts {
  engine: string; // required, explicit; never 'auto'
  cwd: string;
  mcpServers?: McpServerConfig[];
  systemInstructions?: string;
  resume?: string; // a prior sessionId to restore instead of starting fresh
  permissionPolicy?: PermissionPolicy;
  config?: Record<string, string | boolean>;
  /** Overrides `defaults.sessionIdleTimeoutMs` for this session. */
  sessionIdleTimeoutMs?: number;
  /** Overrides `defaults.reactivationAttempts` for this session. */
  reactivationAttempts?: number;
  /** Overrides `defaults.requestTimeoutMs` for this session. */
  requestTimeoutMs?: number;
  /** Overrides `defaults.turnTimeoutMs` for this session. */
  turnTimeoutMs?: number;
}

export type Unsubscribe = () => void;

export type HubEvent =
  'engine:crash' | 'engine:restarted' | 'engine:unauthenticated' | 'engine:cleanup-failed';

/**
 * A compensation runskein could not complete after an operation timed out.
 *
 * Emitted rather than thrown because the caller has already been rejected: this
 * reports what was left behind — an engine-side session that may still exist, a
 * cancellation that never reached the engine — so the ambiguity is visible
 * instead of silent.
 */
export interface EngineCleanupFailure {
  engineId: string;
  sessionId?: string;
  /** The wire operation whose cleanup could not be completed. */
  operation: string;
  /** Engine-side session id, when one was learned before the failure. */
  nativeId?: string;
  error: unknown;
}

export interface EngineCrashInfo {
  engineId: string;
  /** Exit code or signal description, when known. */
  detail?: string;
  /** Whether an automatic restart is being attempted. */
  restarting: boolean;
}
