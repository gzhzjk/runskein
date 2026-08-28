/**
 * Session — one conversation on one engine.
 *
 * Turn semantics: prompt() is a turn-level promise;
 * concurrent prompts queue FIFO; cancel() resolves the ACTIVE turn with the
 * engine's orderly stop reason ('cancelled' per ACP) and rejects QUEUED
 * prompts with CancelledError; close() rejects active+queued with
 * CancelledError, is idempotent, and releases the engine reference.
 *
 * Transcript: every session/update is enveloped {seq, ts, sessionId,
 * engineId} and persisted automatically; the consumer only reads. Store
 * failures surface as StoreError at the prompt()/close() API boundary,
 * never silently.
 */
import { randomUUID } from 'node:crypto';
import { RequestTimeoutError, type AcpPromptResult } from '../acp/connection.js';
import type { AcquiredEngine } from '../process/manager.js';
import type {
  PermissionRequestLike,
  QuestionRequestLike,
  QuestionResponseLike,
  TerminalRequestLike,
} from '../acp/clientMethods.js';
import { authorizeTerminalEnv, SessionTerminals, type TerminalCreateParams } from '../process/terminal.js';
import {
  CancelledError,
  ConfigError,
  EngineCrashError,
  EngineOperationError,
  NotFoundError,
  NotSupportedError,
  StoreError,
  UnauthenticatedError,
  storeBoundaryError,
} from '../errors.js';
import { operationErrorKind, type AdapterErrorCause } from '../errorTaxonomy.js';
import {
  decisionToOutcome,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionRequest,
} from '../permission/policy.js';
import {
  addUsage,
  combineCosts,
  diffUsage,
  foldUsage,
  foldUsageReport,
  readCost,
  syntheticUsageUpdate,
  promptEchoUpdate,
  type CostInfo,
  sessionMetaUpdate,
  type SessionStatus,
  type TranscriptEvent,
  type Usage,
  type UsageMapping,
  type UsageSummary,
} from '../transcript/event.js';
import type { TranscriptStore } from '../transcript/store.js';
import type {
  CapabilityMatrix,
  ConfigOption,
  EngineDescriptor,
  SelectGroup,
  SelectOption,
} from '../types.js';
import type {
  ContentBlock,
  PermissionOption,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from '../vocabulary.js';
import { ConfigStateTracker, type SessionConfigState, type SessionCreationState } from './configState.js';
import type { IdleClock } from './idleClock.js';
import { TurnQueue } from './turnQueue.js';

/** @internal unique-symbol hooks keep lifecycle plumbing off the public surface. */
export const initializeSessionPersistence: unique symbol = Symbol('initializeSessionPersistence');
export const disposeFailedSessionCreation: unique symbol = Symbol('disposeFailedSessionCreation');
export const markEngineCrashed: unique symbol = Symbol('markEngineCrashed');

export interface TurnResult {
  stopReason: StopReason;
  usage?: Usage;
  durationMs: number;
  /**
   * Whatever the engine reported under `_meta.quota` on the prompt response,
   * passed through untouched, or absent when it reported nothing.
   *
   * Deliberately opaque and engine-scoped: only one of the bundled engines
   * emits anything here and its shape is its own, so runskein does not invent a
   * cross-engine vocabulary from a single example. `payload` is therefore
   * `unknown` — read it against the engine you named, not generically.
   *
   * This is NOT a remaining allowance. No engine currently reports a ceiling,
   * reset, or balance, and the field is never back-filled from usage
   * accounting: presenting token counts as headroom would hand an unattended
   * host a confidently wrong budget signal. runskein's own token and cost
   * accounting stays in `usage`.
   */
  quota?: { engineId: string; payload: unknown };
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  engineId: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
}

export type Answer = { text: string } | { optionId: string };

export type ResumeTier = 'native' | 'load' | 'rebuilt';

/** Options controlling engine-side cleanup when closing a session. */
export interface CloseOptions {
  /** Delete the engine-side session after closing it when the engine supports `session/delete`. */
  discard?: boolean;
}

/** How the session came to exist — drives seq continuation and meta events. */
export type SessionOpening =
  | { kind: 'create' }
  | {
      kind: 'resume';
      tier: ResumeTier;
      /** Last stored seq of the prior life; new events continue after it. */
      initialSeq: number;
      /** Rebuilt tier only: digest text injected ahead of the first prompt. */
      preamble?: string;
      /** Additive totals of the engine sessions a rebuild left behind. */
      baselineUsage?: Usage;
      baselineCost?: CostInfo;
      mixedCostCurrencies?: boolean;
      /** Live-counter seed when an existing engine session is continued. */
      initialUsage?: Usage;
      initialCost?: CostInfo;
    }
  | {
      kind: 'detached';
      status: SessionStatus;
      initialSeq: number;
      baselineUsage?: Usage;
      baselineCost?: CostInfo;
      mixedCostCurrencies?: boolean;
      initialUsage?: Usage;
      initialCost?: CostInfo;
    };

type SessionEvent = 'update' | 'permission' | 'question' | 'status' | 'reactivated';

/** Reported whenever a suspended or crashed session is rebuilt on an engine. */
export interface ReactivationInfo {
  /**
   * Which resume tier restored the conversation. `rebuilt` means the engine
   * could neither resume nor load, so the transcript digest was replayed as
   * fresh context — correct, but it spends tokens, which is why this event
   * exists rather than the recovery being invisible.
   */
  tier: ResumeTier;
}

/** What the hub hands back after re-establishing a session on an engine. */
export interface ReactivationBinding {
  acquired: AcquiredEngine;
  nativeSessionId: string;
  capabilities: CapabilityMatrix;
  tier: ResumeTier;
  /** Rebuilt tier only: recovered-context digest for the next prompt. */
  preamble?: string;
  /** Config state the reviving call reported, for `observed`. */
  creationState?: SessionCreationState;
}

/** Everything hub wires into a live session (not part of the public API). */
export interface SessionInternals {
  sessionId: string;
  engineId: string;
  cwd: string;
  nativeSessionId: string;
  acquired: AcquiredEngine;
  store: TranscriptStore;
  policy: PermissionPolicy;
  /** Masked capability matrix (capabilityOverride applied). */
  capabilities: CapabilityMatrix;
  /** Cached engine descriptor — backs setConfig() validation. */
  describe: () => Promise<EngineDescriptor>;
  /** Default: { kind: 'create' }. */
  opening?: SessionOpening;
  /**
   * Raw engine result of the call that produced this session, used to seed
   * `observed` config state. Absent for sessions with no such call behind them,
   * such as a detached view rebuilt from the transcript.
   */
  creationState?: SessionCreationState;
  /** Idle countdown before the engine reference is released; absent disables it. */
  sessionIdleTimeoutMs?: number;
  /** Retries allowed within one reactivation episode. */
  reactivationAttempts: number;
  /** Timer source for the idle countdown (injectable for deterministic tests). */
  idleClock: IdleClock;
  /** Ceiling for setup-class requests (config writes, cancel, close). */
  requestTimeoutMs: number;
  /** Adapter env scrub patterns, applied to commands run for the engine. */
  envScrubExtra?: readonly RegExp[];
  /** How long to wait for a timed-out request to settle before giving up. */
  cleanupWindowMs: number;
  /** Ceiling for one turn; absent means prompts are unbounded, as before. */
  turnTimeoutMs?: number;
  /**
   * Register work that must finish before the hub may consider itself quit —
   * cancelling a timed-out turn, awaiting a request that has not settled.
   * @param work - the compensation to wait on.
   */
  trackCleanup: (work: Promise<unknown>) => void;
  /**
   * Report a compensation that could not be completed.
   * @param failure - the operation, native id where known, and the typed error.
   */
  reportCleanupFailure: (failure: { operation: string; nativeId?: string; error: unknown }) => void;
  /** Classify raw ACP failures with the adapter's prevalidated data. */
  classifyFailure?: (failure: unknown) => AdapterErrorCause | undefined;
  /**
   * The adapter's declared usage mapping (decision 033). Absent means the
   * default: token-bearing `usage_update` notifications, cumulative semantics.
   */
  usageMapping?: UsageMapping;
  /** Mark the engine unauthenticated and start conservative recovery. */
  markUnauthenticated?: () => string | undefined;
  /**
   * Give up routing and the engine reference without closing the session.
   * Unlike `detach`, the session stays known to the hub so it can come back.
   */
  suspend: () => void;
  /**
   * Re-establish this session on an engine: acquire, run the resume chain, and
   * re-register routing.
   *
   * This is the single place recovery re-establishes an engine, deliberately —
   * whether recovery needs a fresh process or could reuse a live one is an
   * open measurement, so the strategy is swappable here without touching the
   * session's state machine.
   */
  reactivate: () => Promise<ReactivationBinding>;
  /** Unregister from the hub's update router. */
  detach: () => void;
  /** Perform session/fork and create the sibling under the hub's creation router. */
  forkFactory: () => Promise<Session>;
}

interface PendingQuestion {
  resolve: (response: QuestionResponseLike) => void;
  propertyName: string;
}

/**
 * Read an engine's quota blob off a prompt response.
 *
 * Presence of the `_meta.quota` key is the whole test: an engine that sends
 * `_meta: {}` has reported nothing, and must not end up with a field implying
 * it did. Nothing is parsed, reshaped, or defaulted — the value goes through
 * exactly as it arrived.
 * @param response - the raw prompt response.
 * @returns a wrapper holding the reported value, or undefined when the engine
 * reported none. The wrapper keeps "reported nothing" distinct from "reported
 * a nullish value", which a bare return could not express.
 */
function readQuota(response: unknown): { payload: unknown } | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const meta = (response as Record<string, unknown>)['_meta'];
  if (typeof meta !== 'object' || meta === null) return undefined;
  if (!('quota' in meta)) return undefined;
  return { payload: (meta as Record<string, unknown>)['quota'] };
}

/**
 * Walk an object-key path into a prompt response (decision 033 §3). Objects
 * only — no array indexing, no wildcards: a path that resolves to a non-object
 * or does not resolve yields no report, which is an ordinary absent-usage
 * turn, not an error.
 * @param response - the raw prompt response.
 * @param path - the adapter-declared object-key path.
 * @returns the resolved object, or undefined when nothing usable is there.
 */
function resolveUsagePath(response: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = response;
  for (const segment of path) {
    // Objects only at every hop — an array is never a legal intermediate, so
    // no path can smuggle array indexing past the "objects only" contract.
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

/** All selectable values of a select option, flat or grouped. */
function flattenSelectValues(option: ConfigOption): string[] {
  const entries = option.options ?? [];
  return entries.flatMap((entry) =>
    'options' in entry
      ? (entry as SelectGroup).options.map((o) => o.value)
      : [(entry as SelectOption).value],
  );
}

export class Session {
  readonly id: string;
  readonly engine: string;
  readonly cwd: string;
  /** Which resume tier restored this session; undefined for fresh sessions. */
  readonly resumeTier?: ResumeTier;

  private readonly internals: SessionInternals;
  private readonly queue = new TurnQueue<TurnResult>(() => this.touchIdle());
  private readonly listeners = new Map<SessionEvent, Set<(payload: never) => void>>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** Abort hooks for in-flight permission policy calls; fired by cancel()/
   * close() so a blocked interactive policy cannot strand the engine's
   * request_permission on the wire. */
  private readonly pendingPermissionAborts = new Set<() => void>();
  /** Commands this session is running for the engine; released when it closes. */
  private terminals: SessionTerminals | undefined;
  private readonly configTracker = new ConfigStateTracker();

  private statusValue: SessionStatus = 'idle';
  private seq = 0;
  private sessionUsage: Usage | undefined;
  private turnUsage: Usage | undefined;
  /** Whether a token-bearing usage report was folded during the open turn. */
  private turnSawTokenReport = false;
  private costInfo: CostInfo | undefined;
  /** Prior-life totals of a rebuilt resume; combined additively (see ctor). */
  private usageBaseline: Usage | undefined;
  private costBaseline: CostInfo | undefined;
  private mixedCostCurrencies = false;
  private turnActive = false;
  /**
   * Settles when the active turn's prompt has been written to the engine, or
   * when the turn ended without it ever being written. A cancel that arrives
   * while the session is bound waits here: cancelling a turn the engine has
   * not been told about cancels nothing, and the turn would then run to
   * completion. A cancel on a session with no engine to notify does not wait —
   * it marks the barrier `aborted` instead, so the reactivation the turn is
   * parked in cannot go on to dispatch it.
   */
  private dispatch:
    { done: Promise<boolean>; settle: (dispatched: boolean) => void; aborted: boolean } | undefined;
  private closedFlag = false;
  /** The first close call owns cleanup; later compatible calls observe its outcome. */
  private closePromise: Promise<void> | undefined;
  /** Whether the first close call requested engine-side deletion. */
  private closeDiscards = false;
  /**
   * Whether the session currently holds an engine reference. False means
   * suspended (idle release) or crashed; either way the next use reactivates.
   */
  private bound = true;
  /** Serializes suspend, reactivate, and close so ownership changes once. */
  private transition: Promise<unknown> = Promise.resolve();
  /** Cancels a scheduled idle countdown; undefined when none is pending. */
  private cancelIdleCountdown: (() => void) | undefined;
  /**
   * Set when the engine died under this session but the crash has not been
   * processed yet. The turn that hit the dead connection knows immediately,
   * while the reference is only handed back once the manager has seen the
   * exit — so this is what tells the next use to rebuild rather than reuse.
   */
  private connectionLost = false;
  /**
   * True while a reactivation holds the transition lock. The crash listener
   * stands down during that window: the binding is being replaced right now,
   * and reaching in to release it would hand back whichever reference the
   * revival had just installed.
   */
  private reactivating = false;
  private pendingPreamble: string | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private persistError: NotFoundError | StoreError | undefined;

  /** @internal — construct through hub.session()/attach()/fork(). */
  constructor(internals: SessionInternals) {
    this.internals = internals;
    this.id = internals.sessionId;
    this.engine = internals.engineId;
    this.cwd = internals.cwd;
    const opening = internals.opening ?? { kind: 'create' };
    if (internals.creationState) {
      this.configTracker.recordSessionState(internals.creationState.state, internals.creationState.source);
    }

    // A rebuilt resume carries its recovered context as a digest preamble on
    // the first prompt rather than as session/new _meta, because _meta is
    // advisory — some engines drop it, and the context must reach all of them.
    if (opening.kind === 'resume' && opening.preamble !== undefined) {
      this.pendingPreamble = opening.preamble;
    }

    switch (opening.kind) {
      case 'create':
        // Creation is recorded as a transcript event, which is what makes the
        // session visible to sessions() on any TranscriptStore implementation.
        this.record(
          sessionMetaUpdate({
            cwd: internals.cwd,
            status: 'idle',
            nativeSessionId: internals.nativeSessionId,
          }),
        );
        break;
      case 'resume':
        this.seq = opening.initialSeq;
        this.resumeTier = opening.tier;
        // Engine sessions that are already closed only ever add to the
        // baseline, while the live counter — seeded when we continue an
        // existing engine session, empty when the session was rebuilt — keeps
        // replace semantics for the engine's own cumulative reports. Together
        // they guarantee usage() never goes backwards across a resume chain.
        this.usageBaseline = opening.baselineUsage;
        this.costBaseline = opening.baselineCost;
        this.mixedCostCurrencies = opening.mixedCostCurrencies === true;
        this.sessionUsage = opening.initialUsage;
        this.costInfo = opening.initialCost;
        this.record(
          sessionMetaUpdate({
            cwd: internals.cwd,
            status: 'idle',
            nativeSessionId: internals.nativeSessionId,
            resumeTier: opening.tier,
          }),
        );
        break;
      case 'detached':
        // Read-only view over the store: no engine, no writes; the closed
        // flag reuses the closed-session behavior for every mutating call.
        this.bound = false;
        this.seq = opening.initialSeq;
        this.statusValue = opening.status;
        this.usageBaseline = opening.baselineUsage;
        this.costBaseline = opening.baselineCost;
        this.mixedCostCurrencies = opening.mixedCostCurrencies === true;
        this.sessionUsage = opening.initialUsage;
        this.costInfo = opening.initialCost;
        this.closedFlag = true;
        break;
    }
    // A session created and never used still counts down: holding an engine
    // for a conversation nobody starts is exactly the waste this prevents.
    this.touchIdle();
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  // ── events ───────────────────────────────────────────────────────────────

  /**
   * Subscribe to a session event. A listener that throws is logged and
   * skipped, so one bad listener cannot break the turn.
   * @param event - update, permission, question, or status.
   * @param cb - the listener.
   * @returns a function that removes the listener.
   */
  on(event: 'update', cb: (e: TranscriptEvent) => void): () => void;
  on(event: 'permission', cb: (req: PermissionRequest) => void): () => void;
  on(event: 'question', cb: (q: QuestionRequest) => void): () => void;
  on(event: 'status', cb: (st: SessionStatus) => void): () => void;
  on(event: 'reactivated', cb: (info: ReactivationInfo) => void): () => void;
  on(event: SessionEvent, cb: (payload: never) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  private emit(event: SessionEvent, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        (cb as (p: unknown) => void)(payload);
      } catch (e) {
        console.error(`[runskein] session ${event} listener threw: ${(e as Error).message}`);
      }
    }
  }

  private setStatus(status: SessionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit('status', status);
  }

  // ── lifetime: idle release and reactivation ──────────────────────────────

  /**
   * Run one state transition at a time.
   *
   * Suspend, reactivate, and close all change who owns the engine reference,
   * so they are serialized: without this a prompt arriving mid-release could
   * acquire while the release was still in flight, ending with two references
   * or none.
   * @param body - the transition to run.
   * @returns the body's result.
   */
  private withTransition<T>(body: () => Promise<T>): Promise<T> {
    const result = this.transition.then(body, body);
    // The chain must not inherit this body's rejection, or every later
    // transition would reject with a stale error.
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Whether the session may release its engine reference right now.
   *
   * Deliberately strict: anything the engine still owes an answer to — a
   * running turn, a queued prompt, an unanswered permission or question —
   * makes releasing the connection a way to strand it.
   * @returns true when releasing is safe.
   */
  private canSuspend(): boolean {
    return (
      !this.closedFlag &&
      this.bound &&
      this.statusValue === 'idle' &&
      !this.queue.isActive &&
      this.queue.pending === 0 &&
      this.pendingQuestions.size === 0 &&
      this.pendingPermissionAborts.size === 0 &&
      // A command still running was started on this session's behalf; letting
      // the engine reference go underneath it would strand the process and
      // whatever the agent meant to read from it.
      !(this.terminals?.hasRunning() ?? false)
    );
  }

  /**
   * Restart the idle countdown after activity, or stop it when it cannot run.
   *
   * Called from every point that counts as the session being used, so an
   * active conversation never releases its engine underneath itself.
   */
  private touchIdle(): void {
    this.cancelIdleCountdown?.();
    this.cancelIdleCountdown = undefined;
    const ms = this.internals.sessionIdleTimeoutMs;
    if (ms === undefined || !this.canSuspend()) return;
    this.cancelIdleCountdown = this.internals.idleClock.schedule(ms, () => {
      this.cancelIdleCountdown = undefined;
      void this.suspendIfIdle();
    });
  }

  /**
   * Release the engine reference if the session is still idle when the
   * countdown fires.
   *
   * The conditions are re-checked inside the transition lock, not before it:
   * a prompt that arrives while this is queued must win, and it does because
   * enqueueing marks the queue non-empty synchronously.
   */
  private async suspendIfIdle(): Promise<void> {
    await this.withTransition(async () => {
      if (!this.canSuspend()) {
        // Something arrived while this was waiting for the lock; restart the
        // countdown instead of releasing under a live turn.
        this.touchIdle();
        return;
      }
      this.bound = false;
      this.internals.suspend();
    });
  }

  /**
   * Make sure the session holds a usable engine reference, reactivating it if
   * it was suspended or lost to a crash.
   * @throws CancelledError when the session is closed.
   * @throws UnauthenticatedError when a prior auth failure still blocks recovery.
   * @throws EngineOperationError `session/reactivate` when the attempt cap is exhausted.
   */
  private async ensureActive(): Promise<void> {
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
    if (this.bound && !this.connectionLost) return;
    await this.withTransition(async () => {
      if (this.closedFlag) throw new CancelledError(this.engine, this.id);
      // Another caller may have rebuilt it while we waited for the lock.
      if (this.bound && !this.connectionLost) return;
      await this.reactivateLocked();
    });
    // Reactivation records its own event, so a listener can close the session
    // from inside it. Every caller of this method is about to use the engine.
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
  }

  /**
   * Rebuild this session on an engine, retrying up to the configured cap.
   *
   * The counter is local to this episode: a caller that catches the exhaustion
   * error and tries again starts a new bounded episode, which is an explicit
   * decision rather than a silent retry loop.
   * @throws CancelledError when the session closed while an attempt was in flight.
   * @throws UnauthenticatedError when a prior auth failure still blocks recovery.
   * @throws EngineOperationError naming the cap once every retryable attempt has failed.
   */
  private async reactivateLocked(): Promise<void> {
    const cap = this.internals.reactivationAttempts;
    let attempts = 0;
    let lastError: unknown;
    while (attempts < cap) {
      // close() marks this synchronously while its cleanup waits for the
      // transition lock. Do not start another acquire after close has won.
      if (this.closedFlag) throw new CancelledError(this.engine, this.id);
      attempts++;
      let binding: ReactivationBinding | undefined;
      // A crash the manager has not processed yet leaves this session holding a
      // dead reference. Keep holding it across the acquire below: dropping it
      // first could take the engine's reference count to zero, which the
      // manager reads as an idle crash and skips the restart for.
      const stale = this.bound ? this.internals.acquired : undefined;
      this.reactivating = true;
      try {
        binding = await this.internals.reactivate();
        stale?.release();
        if (this.closedFlag) {
          // close() won while this was in flight. Reactivate already
          // re-registered routing under the new engine-side id. That routing
          // half is not strictly load-bearing here: closeLocked() runs next in
          // the transition queue and detaches under the same key regardless,
          // via the hub's compare-and-delete on the current key. It must first
          // adopt this binding, so cleanup reaches this native session rather
          // than the stale one it replaced.
          this.adoptBinding(binding);
          throw new CancelledError(this.engine, this.id);
        }
        this.adoptBinding(binding);
        // Announced as soon as the resume chain lands, before anything that
        // could still fail: the `rebuilt` tier has already spent tokens by this
        // point, and a cost the host is never told about is the silent
        // degradation this event exists to prevent.
        this.emit('reactivated', { tier: binding.tier } satisfies ReactivationInfo);
        // Config is re-applied by runskein rather than trusted to the engine:
        // whether a resumed session keeps its model is unproven, and a session
        // silently running on a different model is the failure this prevents.
        // A refusal here is real engine drift, so it fails the attempt.
        const desired = this.configTracker.snapshot().desired;
        if (Object.keys(desired).length > 0) await this.applyConfig({ ...desired });
        this.touchIdle();
        return;
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        lastError = e;
        if (binding !== undefined) {
          // The binding was adopted but config re-application failed; drop it
          // so the next attempt starts from a clean suspended state.
          this.bound = false;
          this.internals.suspend();
        }
        // Auth is a caller action boundary, not a transient resume failure. A
        // retry loop would hide its typed signal behind the attempt-cap error
        // and could keep spawning while the registry intentionally blocks it.
        if (e instanceof UnauthenticatedError) {
          this.releaseFailedReactivation();
          throw e;
        }
        if (attempts < cap) {
          // Yield a macrotask before retrying: the common reason an attempt
          // finds no healthy engine is that the child's exit event has not been
          // delivered yet, and the manager cannot decide to restart until it is.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        this.reactivating = false;
      }
    }
    this.releaseFailedReactivation();
    throw new EngineOperationError({
      engineId: this.engine,
      sessionId: this.id,
      operation: 'session/reactivate',
      cause: { attempts, cap, lastError },
    });
  }

  /** Release a binding that cannot serve the current recovery episode. */
  private releaseFailedReactivation(): void {
    // Keep a dead connection pinned until the manager's exit handler observes
    // it. Releasing it first makes the crash look idle and suppresses the
    // restart signal; a live but untrusted connection can be released safely.
    if (!this.bound || this.internals.acquired.connection.isClosed) return;
    this.bound = false;
    this.internals.suspend();
  }

  /**
   * Adopt a fresh engine binding and record the recovery in the transcript.
   * @param binding - the engine reference, native id, and capabilities to run on.
   */
  private adoptBinding(binding: ReactivationBinding): void {
    this.internals.acquired = binding.acquired;
    this.internals.nativeSessionId = binding.nativeSessionId;
    this.internals.capabilities = binding.capabilities;
    this.bound = true;
    this.connectionLost = false;
    if (binding.preamble !== undefined) this.pendingPreamble = binding.preamble;
    if (binding.creationState) {
      this.configTracker.recordSessionState(binding.creationState.state, binding.creationState.source);
    }
    // Status before the event, so a listener that reads s.status while
    // handling the reactivation meta event sees the session it describes.
    this.setStatus('idle');
    this.record(
      sessionMetaUpdate({
        cwd: this.cwd,
        status: 'idle',
        nativeSessionId: binding.nativeSessionId,
        resumeTier: binding.tier,
      }),
    );
  }

  // ── prompting ────────────────────────────────────────────────────────────

  /**
   * Run one turn with the given input, queued FIFO behind any active turn.
   * @param input - plain text, or an array of content blocks.
   * @returns the turn result: stopReason, duration, and usage when the engine
   * reported any.
   * @throws CancelledError when the session is closed, or when this prompt was
   * still queued at cancel()/close() time.
   * @throws EngineCrashError when the engine process died mid-turn.
   * @throws StoreError when persisting the turn's transcript failed.
   * @throws UnauthenticatedError when the engine reports expired credentials.
   * @throws EngineOperationError when the engine rejected the prompt for another reason.
   */
  async prompt(input: string | ContentBlock[]): Promise<TurnResult> {
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
    const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    // Enqueueing marks the queue non-empty before any await, which is what lets
    // a prompt racing the idle countdown win: the countdown re-checks under the
    // lock and stands down instead of releasing the engine out from under it.
    const turn = this.queue.enqueue(() => this.runTurn(blocks));
    this.touchIdle();
    return turn;
  }

  /**
   * Execute a single turn on the engine and persist its transcript.
   * @param blocks - the user content blocks for this turn.
   * @returns the turn result.
   * @throws CancelledError, EngineCrashError, StoreError, or
   * EngineOperationError, depending on which failure path was taken.
   */
  private async runTurn(blocks: ContentBlock[]): Promise<TurnResult> {
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
    // The barrier opens before the first await: from here on this turn is the
    // active one, so a cancel or close can arrive at any suspension point —
    // reactivation, the echoes runskein records, dispatch itself.
    this.openDispatchBarrier();
    try {
      return await this.runTurnDispatched(blocks);
    } finally {
      this.turnActive = false;
      this.closeDispatchBarrier(false);
    }
  }

  /**
   * Whether a cancel gave up on the active turn before it ever dispatched.
   * Read through a method because it is set from `cancel()` while the turn is
   * suspended, which the compiler cannot see from the turn body.
   * @returns true when the active turn must stop instead of prompting.
   */
  private get turnAborted(): boolean {
    return this.dispatch?.aborted === true;
  }

  /** Open the barrier for a turn that is about to start. */
  private openDispatchBarrier(): void {
    let settle!: (dispatched: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.dispatch = { done, settle, aborted: false };
  }

  /**
   * Settle the current turn's barrier. Idempotent: the turn settles it once at
   * dispatch and again when it ends, and only the first settlement counts.
   * @param dispatched - whether the prompt reached the engine.
   */
  private closeDispatchBarrier(dispatched: boolean): void {
    this.dispatch?.settle(dispatched);
    if (!dispatched) this.dispatch = undefined;
  }

  /**
   * The turn itself, from reactivation to settlement, with the dispatch
   * barrier already open.
   * @param blocks - the caller's prompt blocks.
   * @returns the turn result.
   */
  private async runTurnDispatched(blocks: ContentBlock[]): Promise<TurnResult> {
    // Suspended or crash-orphaned sessions come back here, inside the queue, so
    // concurrent prompts share one reactivation instead of racing to acquire.
    await this.ensureActive();
    // A cancel that arrived while this turn waited to be revived already
    // rejected its caller; reviving the session only to prompt with nobody
    // listening is the one thing left to avoid.
    if (this.turnAborted) throw new CancelledError(this.engine, this.id);
    this.turnActive = true;
    // A turn value means THIS TURN on every engine (decision 033 §4). For a
    // cumulative reporter that is the per-field difference against the session
    // counter as it stood when the turn opened — so the snapshot is taken here,
    // not left to a turn counter folded through the replace path (which used to
    // make TurnResult.usage read "everything so far").
    this.turnUsage = undefined;
    // A turn with no usage report at all must leave TurnResult.usage absent
    // (not an all-zeros delta), so settlement only runs for turns that saw one.
    this.turnSawTokenReport = false;
    const turnOpenUsage = this.sessionUsage === undefined ? undefined : { ...this.sessionUsage };
    const usageMapping = this.internals.usageMapping;
    const metaSourced = usageMapping?.source.kind === 'prompt_response_meta';
    this.setStatus('running');
    const t0 = Date.now();

    // A rebuilt resume prepends its recovered-context digest to the first
    // prompt; every later turn sends the caller's blocks unchanged.
    let sendBlocks = blocks;
    if (this.pendingPreamble !== undefined) {
      sendBlocks = [{ type: 'text', text: this.pendingPreamble }, ...blocks];
      this.pendingPreamble = undefined;
    }
    for (const block of sendBlocks) {
      this.record(promptEchoUpdate(block));
    }

    // A listener could have closed or cancelled the session while the echoes
    // went out; the engine must not be given a prompt after either won.
    if (this.closedFlag || this.turnAborted) {
      throw new CancelledError(this.engine, this.id);
    }

    try {
      // The prompt request is written when sendPrompt is CALLED; awaiting it
      // waits for the turn to end. Settling the barrier between the two is
      // what releases a cancel that has been waiting for the engine to have
      // something to cancel.
      const pending = this.sendPrompt(sendBlocks);
      this.closeDispatchBarrier(true);
      const resp = await pending;
      // Notifications written before the prompt response (usage_update is the
      // canonical case) may still be in the dispatch queue — drain before
      // snapshotting the turn's usage.
      await new Promise((r) => setImmediate(r));
      if (metaSourced) {
        this.settleMetaSourcedUsage(resp, usageMapping!, turnOpenUsage);
      } else if (this.turnSawTokenReport && this.sessionUsage !== undefined) {
        const turnValue = diffUsage(this.sessionUsage, turnOpenUsage);
        if (turnValue !== undefined) this.turnUsage = turnValue;
      }
      const result: TurnResult = {
        stopReason: resp.stopReason as StopReason,
        durationMs: Date.now() - t0,
      };
      if (this.turnUsage !== undefined) result.usage = this.turnUsage;
      const quota = readQuota(resp);
      if (quota !== undefined) result.quota = { engineId: this.engine, payload: quota.payload };
      await this.flushPersist();
      if (!this.closedFlag) this.setStatus('idle');
      return result;
    } catch (e) {
      const classification = this.internals.classifyFailure?.(e);
      if (this.closedFlag) {
        // close() owns the in-flight turn's public outcome, but an engine may
        // still reply with expired credentials after cancellation. Record that
        // fact before preserving close's documented CancelledError contract.
        if (classification === 'auth') this.engineOperationError('session/prompt', e, classification);
        throw new CancelledError(this.engine, this.id);
      }
      const mapped = this.mapTurnError(e, classification);
      try {
        await this.flushPersist();
      } catch (storeFailure) {
        const normalized = storeBoundaryError('append', storeFailure, {
          engineId: this.engine,
          sessionId: this.id,
        });
        if (normalized instanceof StoreError) {
          if (mapped instanceof UnauthenticatedError) {
            throw new UnauthenticatedError(
              mapped.engineId,
              mapped.loginHint,
              new AggregateError(
                [mapped.cause ?? mapped, normalized.cause ?? normalized],
                'turn and transcript persistence both failed',
              ),
            );
          }
          throw new StoreError({
            operation: 'append',
            cause: new AggregateError(
              [normalized.cause ?? normalized, mapped],
              'turn and transcript persistence both failed',
            ),
            engineId: this.engine,
            sessionId: this.id,
          });
        }
        throw normalized;
      }
      throw mapped;
    }
  }

  /**
   * Send one turn and, when a turn ceiling is configured, bound the wait.
   *
   * A timeout here does NOT cancel the turn in the sense decision 001 governs.
   * That rule is about a turn the caller cancelled, which still resolves with
   * `stopReason: 'cancelled'`; here the caller is handed a rejection and has no
   * turn left to resolve. What is left is an engine still working on a request
   * runskein has stopped waiting for, so this rejects the caller, asks the engine
   * to stop, and then keeps the FIFO slot occupied until the original request
   * actually settles. Releasing the slot early would let the next prompt reach
   * the engine while the abandoned one is still running.
   * @param blocks - the content blocks to send.
   * @returns the prompt response.
   * @throws EngineOperationError `session/prompt` with kind `timeout` once the ceiling passes.
   */
  private async sendPrompt(blocks: ContentBlock[]): Promise<AcpPromptResult> {
    const wire = this.internals.acquired.connection.prompt({
      sessionId: this.internals.nativeSessionId,
      prompt: blocks as unknown[],
    });
    const ceiling = this.internals.turnTimeoutMs;
    // Unset means unbounded, which is the historical behaviour and the default:
    // a legitimate turn can run for many minutes, so runskein invents no ceiling.
    if (ceiling === undefined) return wire;

    const nativeId = this.internals.nativeSessionId;
    let expired = false;
    const timer = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => {
        expired = true;
        resolve('timeout');
      }, ceiling);
      handle.unref?.();
    });
    const outcome = await Promise.race([wire.then(() => 'settled' as const), timer]);
    if (outcome === 'settled' || !expired) return wire;

    const timedOut = new EngineOperationError({
      engineId: this.engine,
      sessionId: this.id,
      operation: 'session/prompt',
      kind: 'timeout',
      cause: new Error(`turn exceeded ${String(ceiling)}ms`),
    });
    // Reject the caller now, but leave this turn holding the queue: the slot is
    // released only when the engine finally answers.
    this.queue.rejectActive(timedOut);

    // Ask the engine to stop. A cancellation that never lands is exactly the
    // kind of ambiguity that must be reported rather than assumed away.
    const cancelled = this.internals.acquired.connection.cancelSession(nativeId).catch((error: unknown) => {
      this.internals.reportCleanupFailure({ operation: 'session/cancel', nativeId, error });
    });
    this.internals.trackCleanup(cancelled);

    const drained = wire.then(
      () => undefined,
      () => undefined,
    );
    this.internals.trackCleanup(drained);

    // Bounded, because an engine that never answers at all would otherwise hold
    // this slot forever: every later prompt would queue behind it and the
    // session would wedge silently — the very failure this capability exists to
    // remove, reintroduced one level up. Waiting is still the default, since a
    // late answer frees the slot cleanly; giving up is the exception.
    let settled = false;
    const window = new Promise<'unsettled'>((resolve) => {
      const handle = setTimeout(() => resolve('unsettled'), this.internals.cleanupWindowMs);
      handle.unref?.();
    });
    const drainOutcome = await Promise.race([drained.then(() => 'settled' as const), window]);
    settled = drainOutcome === 'settled';
    if (!settled) {
      // Never treated as done: the engine may still be working on a request
      // nobody is waiting for, and the connection can no longer be trusted to
      // carry this session's traffic in order.
      this.internals.reportCleanupFailure({
        operation: 'session/prompt',
        nativeId,
        error: new Error(
          `no response within ${String(this.internals.cleanupWindowMs)}ms of the turn timing out`,
        ),
      });
      // Hand the session to the recovery path rather than leaving it bound to a
      // connection with an abandoned request still outstanding on it.
      this.connectionLost = true;
    }
    // Re-thrown so the queue's own bookkeeping unwinds; the caller was already
    // rejected above, so `rejectActive` has made this a no-op for them.
    throw timedOut;
  }

  /**
   * Classify a turn failure into the matching runskein error.
   * @param e - the raw rejection from the engine or persistence layer.
   * @returns the typed error to surface to the prompt() caller.
   */
  private mapTurnError(e: unknown, classification = this.internals.classifyFailure?.(e)): Error {
    if (e instanceof NotFoundError || e instanceof StoreError) {
      if (!this.closedFlag) this.setStatus('idle');
      return e;
    }
    if (classification === 'auth') {
      return this.engineOperationError('session/prompt', e, classification);
    }
    if (this.internals.acquired.connection.isClosed) {
      // Process died mid-turn. The hub's engine:crash listener runs
      // [markEngineCrashed] to free what this session holds; the release must
      // NOT happen here — the prompt rejection (stream EOF) can beat the
      // child's 'exit' event, and a refcount already at zero would make the
      // manager misread a mid-turn crash as an idle crash and skip the
      // restart. Recording is idempotent with the listener's.
      // Known here before the manager's exit handler runs, so the next use
      // rebuilds instead of reaching for the dead connection again.
      this.connectionLost = true;
      if (this.statusValue !== 'failed') {
        this.setStatus('failed');
        this.record(sessionMetaUpdate({ status: 'failed' }));
      }
      return new EngineCrashError({
        engineId: this.engine,
        sessionId: this.id,
        lastSeq: this.seq,
        restarting: true,
        detail: (e as Error).message,
      });
    }
    // Engine answered with a wire-level error; the session itself survives.
    if (!this.closedFlag) this.setStatus('idle');
    return this.engineOperationError('session/prompt', e, classification);
  }

  /**
   * Build an EngineOperationError tagged with this session and engine.
   * @param operation - the wire operation that failed.
   * @param cause - the underlying error, when present.
   * @returns the typed operation error, including UnauthenticatedError for a recognised auth failure.
   */
  private engineOperationError(
    operation: string,
    cause?: unknown,
    classification = this.internals.classifyFailure?.(cause),
  ): Error {
    if (classification === 'auth') {
      const loginHint = this.internals.markUnauthenticated?.();
      return new UnauthenticatedError(this.engine, loginHint, cause);
    }
    const kind =
      cause instanceof RequestTimeoutError
        ? 'timeout'
        : classification === undefined
          ? undefined
          : operationErrorKind(classification);
    return new EngineOperationError({
      engineId: this.engine,
      sessionId: this.id,
      operation,
      ...(kind !== undefined ? { kind } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /**
   * Cancel the active turn and reject every queued prompt. The active turn
   * still resolves — with the engine's orderly 'cancelled' stop reason — while
   * prompts that never ran reject with CancelledError.
   * @throws UnauthenticatedError when the engine reports expired credentials.
   * @throws EngineOperationError when the session/cancel notification fails for another reason.
   */
  async cancel(): Promise<void> {
    this.queue.rejectQueued(() => new CancelledError(this.engine, this.id));
    if (!this.bound) {
      // No engine to notify. A turn sitting here is one that is still waiting
      // to be revived, so it never reached the engine and rejects like any
      // other prompt that never ran. Rejecting the caller does not stop the
      // turn body, which is still inside reactivation — mark its barrier so it
      // gives up instead of reviving the session and prompting into the void.
      if (this.dispatch !== undefined) this.dispatch.aborted = true;
      this.queue.rejectActive(new CancelledError(this.engine, this.id));
      return;
    }
    if (!this.queue.isActive || this.closedFlag) return;
    const barrier = this.dispatch;
    if (barrier !== undefined) {
      // The turn is active but its prompt may not be written yet — a caller
      // that cancels straight after prompt(), or a listener reaching here from
      // an event runskein records before dispatch, would otherwise cancel nothing
      // and the turn would run to completion. Wait for the prompt to go out;
      // a turn that ends without ever dispatching needs no notification.
      const dispatched = await barrier.done;
      // The turn this cancel was for may have settled while we waited, and the
      // queue may already be running the next one — which this cancel was
      // never about.
      if (!dispatched || this.closedFlag || this.dispatch !== barrier) return;
    }
    // A cancelled turn also cancels its pending elicitations and permission
    // requests — otherwise the agent-side request never resolves and the turn
    // cannot end.
    for (const [id, q] of this.pendingQuestions) {
      q.resolve({ action: 'cancel' });
      this.pendingQuestions.delete(id);
    }
    for (const abort of this.pendingPermissionAborts) abort();
    // Notify the engine; the active prompt then resolves on its own with the
    // orderly 'cancelled' stop reason rather than rejecting here.
    try {
      await this.internals.acquired.connection.cancelSession(this.internals.nativeSessionId);
    } catch (e) {
      throw this.engineOperationError('session/cancel', e);
    }
  }

  /**
   * Close this session and optionally delete its engine-side state.
   * @param opts - `discard` requires the negotiated `session/delete` capability.
   * @returns The first compatible close call's promise.
   * @throws NotSupportedError when discard was requested on an engine without `session/delete`.
   * @throws EngineOperationError when engine cleanup fails or a closed session is later asked to discard.
   * @throws UnauthenticatedError or StoreError when existing cleanup/persistence boundaries fail.
   */
  close(opts: CloseOptions = {}): Promise<void> {
    const discard = opts.discard === true;
    if (this.closePromise) {
      if (discard && !this.closeDiscards) return Promise.reject(this.closedWithoutDiscardError());
      return this.closePromise;
    }
    if (this.closedFlag) {
      return discard ? Promise.reject(this.closedWithoutDiscardError()) : Promise.resolve();
    }
    // Set before awaiting the transition lock so a reactivation already in
    // flight sees the session as closed and refuses to publish its binding.
    this.closedFlag = true;
    this.closeDiscards = discard;
    this.cancelIdleCountdown?.();
    this.cancelIdleCountdown = undefined;
    this.closePromise = this.withTransition(() => this.closeLocked(discard));
    return this.closePromise;
  }

  /**
   * Close body, run under the transition lock so it cannot interleave with a
   * suspend or reactivate.
   * @param discard - whether this close must remove the engine-side session.
   * @throws UnauthenticatedError when cleanup reports expired credentials.
   * @throws EngineOperationError or StoreError when non-auth cleanup fails.
   */
  private async closeLocked(discard: boolean): Promise<void> {
    const failures: Error[] = [];
    // Before anything else: a command started for the agent must not outlive
    // the session that authorised it. One that survives SIGKILL is a leaked
    // process, and the caller closing this session is the last party in a
    // position to hear about it.
    const survivors = (await this.terminals?.releaseAll()) ?? [];
    if (survivors.length > 0) {
      failures.push(new Error(`command(s) survived being killed on close: ${survivors.join(', ')}`));
    }
    let deleteFailure: Error | undefined;
    const wasBound = this.bound;
    try {
      this.queue.rejectQueued(() => new CancelledError(this.engine, this.id));
      const hadActive = this.queue.rejectActive(new CancelledError(this.engine, this.id));
      const connection = this.internals.acquired.connection;
      if (wasBound && hadActive && !connection.isClosed) {
        try {
          await connection.cancelSession(this.internals.nativeSessionId);
        } catch (e) {
          failures.push(this.engineOperationError('session/cancel', e));
        }
      }
      // Plain close remains Core even without a wire close capability. Discard
      // is different: it must report every reason engine-side deletion failed.
      if (wasBound && this.internals.capabilities.session['close'] && !connection.isClosed) {
        try {
          await connection.closeSession(this.internals.nativeSessionId, {
            timeoutMs: this.internals.requestTimeoutMs,
          });
        } catch (e) {
          failures.push(this.engineOperationError('session/close', e));
        }
      }
      if (discard) {
        if (!this.internals.capabilities.session['delete']) {
          deleteFailure = new NotSupportedError(this.engine, 'session.delete', this.id);
          failures.push(deleteFailure);
        } else if (!wasBound || connection.isClosed) {
          deleteFailure = this.engineOperationError(
            'session/delete',
            new Error('session has no live connection for engine-side deletion'),
          );
          failures.push(deleteFailure);
        } else {
          try {
            // Deletion is attempted after a failed close too: a closed turn is
            // not proof that the engine-side session stopped existing.
            await connection.deleteSession(this.internals.nativeSessionId, {
              timeoutMs: this.internals.requestTimeoutMs,
            });
          } catch (e) {
            deleteFailure = this.engineOperationError('session/delete', e);
            failures.push(deleteFailure);
          }
        }
      }
      for (const [id, q] of this.pendingQuestions) {
        q.resolve({ action: 'cancel' });
        this.pendingQuestions.delete(id);
      }
      for (const abort of this.pendingPermissionAborts) abort();
      // Status first: the meta event is emitted to update listeners as it is
      // recorded, and a listener reading s.status must not be told the session
      // closed by an event the session itself has not caught up with.
      this.setStatus('closed');
      this.record(sessionMetaUpdate({ status: 'closed' }));
      try {
        await this.flushPersist();
      } catch (e) {
        failures.push(e as Error);
      }
    } finally {
      this.bound = false;
      this.internals.detach();
      if (wasBound) this.internals.acquired.release();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const authenticationFailure = failures.find((failure) => failure instanceof UnauthenticatedError) as
        UnauthenticatedError | undefined;
      if (authenticationFailure) {
        throw new UnauthenticatedError(
          authenticationFailure.engineId,
          authenticationFailure.loginHint,
          new AggregateError(failures, 'multiple failures while closing session'),
        );
      }
      const storeFailure = failures.find((failure) => failure instanceof StoreError) as
        StoreError | undefined;
      if (storeFailure) {
        throw new StoreError({
          operation: storeFailure.operation,
          cause: new AggregateError(failures, 'multiple failures while closing session'),
          engineId: this.engine,
          sessionId: this.id,
        });
      }
      if (discard && deleteFailure) {
        throw this.engineOperationError(
          'session/delete',
          new AggregateError(failures, 'multiple failures while discarding session'),
        );
      }
      throw this.engineOperationError(
        'session/close',
        new AggregateError(failures, 'multiple failures while closing session'),
      );
    }
  }

  /**
   * Explain why a later discard cannot be fulfilled after an ordinary close.
   * @returns A typed error identifying the unperformed deletion.
   */
  private closedWithoutDiscardError(): EngineOperationError {
    return new EngineOperationError({
      engineId: this.engine,
      sessionId: this.id,
      operation: 'session/delete',
      cause: new Error('session is already closed without engine-side discard'),
    });
  }

  // ── negotiated surface ───────────────────────────────────────────────────

  /**
   * Create an independent sibling session with its own transcript.
   * @returns the forked session.
   * @throws CancelledError when this session is already closed.
   * @throws NotSupportedError when the engine advertises no fork capability.
   * @throws UnauthenticatedError when the engine reports expired credentials.
   * @throws EngineOperationError when the engine's session/fork fails for another reason.
   */
  async fork(): Promise<Session> {
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
    // Forking reads this session's engine-side state, so it must be live first;
    // the capability check follows because the matrix comes from the binding.
    await this.ensureActive();
    if (!this.internals.capabilities.session['fork']) {
      throw new NotSupportedError(this.engine, 'fork', this.id);
    }
    try {
      return await this.internals.forkFactory();
    } finally {
      this.touchIdle();
    }
  }

  /**
   * Apply configuration (model, reasoning, mode, …) to the session.
   *
   * Keys are validated against the engine descriptor before anything is sent:
   * they map onto a ConfigOption id, or onto a category alias (`model` →
   * model, `reasoning` → thought_level, `mode` → session modes). An unknown
   * key or value fails fast with the list of valid values rather than being
   * silently dropped.
   * @param patch - config keys to values.
   * @throws CancelledError when the session is closed.
   * @throws ConfigError on an unknown key or an invalid value.
   * @throws NotSupportedError when the engine has no such control at all.
   * @throws UnauthenticatedError when the engine reports expired credentials.
   * @throws EngineOperationError when a validated write is refused on the wire for another reason.
   */
  async setConfig(patch: Record<string, string | boolean>): Promise<void> {
    if (this.closedFlag) throw new CancelledError(this.engine, this.id);
    await this.ensureActive();
    try {
      await this.applyConfig(patch);
    } finally {
      this.touchIdle();
    }
  }

  /**
   * Validate and write a config patch on the current engine binding.
   *
   * Split from `setConfig` because reactivation re-applies config while it
   * holds the transition lock; going through the public entry point would
   * deadlock on that lock.
   * @param patch - config keys to values.
   * @throws ConfigError, NotSupportedError, or EngineOperationError as setConfig does.
   */
  private async applyConfig(patch: Record<string, string | boolean>): Promise<void> {
    const { connection } = this.internals.acquired;
    const descriptor = await this.internals.describe();

    // Validate the WHOLE patch before touching the engine, so a ConfigError
    // never leaves the session partially reconfigured.
    type PlannedWrite =
      | { kind: 'mode'; key: string; value: string }
      | { kind: 'model'; key: string; value: string }
      | { kind: 'option'; key: string; optionId: string; value: string | boolean };
    const writes: PlannedWrite[] = [];
    for (const [key, value] of Object.entries(patch)) {
      // Creation-only keys are refused before anything else looks at them.
      // NotSupportedError rather than ConfigError on purpose: the key is
      // known and the value may be perfectly valid — what is missing is the
      // engine's ability to take it now, which is what Negotiated means.
      const creationOnly = descriptor.configOptions.find((o) => o.id === key && o.settable === 'creation');
      if (creationOnly !== undefined) {
        throw new NotSupportedError(this.engine, `config:${key}@runtime`, this.id);
      }
      if (key === 'mode') {
        const modes = descriptor.modes ?? [];
        if (modes.length > 0) {
          const modeIds = modes.map((m) => m.id);
          if (typeof value !== 'string' || !modeIds.includes(value)) {
            throw new ConfigError({
              engineId: this.engine,
              key,
              message: `invalid mode '${String(value)}' — valid modes: ${modeIds.join(', ')}`,
              validValues: modeIds,
            });
          }
          writes.push({ kind: 'mode', key, value });
          continue;
        }
        // Some engines (e.g. opencode) advertise modes only as a config
        // option while still accepting set_mode; the descriptor probe just
        // did not report session modes. Route through set_config_option when
        // a mode-category option exists, else the engine truly has no modes.
        const modeOption = descriptor.configOptions.find((o) => o.id === 'mode' || o.category === 'mode');
        if (modeOption) {
          const values = flattenSelectValues(modeOption);
          if (typeof value !== 'string' || !values.includes(value)) {
            throw new ConfigError({
              engineId: this.engine,
              key,
              message: `invalid mode '${String(value)}' — valid modes: ${values.join(', ')}`,
              validValues: values,
            });
          }
          writes.push({ kind: 'option', key, optionId: modeOption.id, value });
          continue;
        }
        throw new NotSupportedError(this.engine, 'mode', this.id);
      }

      // Model selection is its own protocol surface on engines that have no
      // config option for it: they advertise `models` at session creation and
      // take the write through session/set_model.
      //
      // An engine may expose BOTH — codex advertises `models` while also
      // listing `model` in configOptions, with different id spellings on each
      // side. The config option wins there: it is the stable, measured surface,
      // and rerouting it would reject ids that used to work.
      const modelIsConfigOption = descriptor.configOptions.some(
        (o) => o.id === 'model' || o.category === 'model',
      );
      if (key === 'model' && !modelIsConfigOption && (descriptor.models ?? []).length > 0) {
        const modelIds = descriptor.models!.map((m) => m.id);
        if (typeof value !== 'string' || !modelIds.includes(value)) {
          throw new ConfigError({
            engineId: this.engine,
            key,
            message: `invalid model '${String(value)}' — valid models: ${modelIds.join(', ')}`,
            validValues: modelIds,
          });
        }
        writes.push({ kind: 'model', key, value });
        continue;
      }

      const option = this.resolveConfigOption(descriptor, key);
      if (option.type === 'select') {
        const values = flattenSelectValues(option);
        if (typeof value !== 'string' || !values.includes(value)) {
          throw new ConfigError({
            engineId: this.engine,
            key,
            message: `invalid value '${String(value)}' for '${key}' — valid values: ${values.join(', ')}`,
            validValues: values,
          });
        }
      } else if (typeof value !== 'boolean') {
        throw new ConfigError({
          engineId: this.engine,
          key,
          message: `config '${key}' expects a boolean, got '${String(value)}'`,
          validValues: ['true', 'false'],
        });
      }
      writes.push({ kind: 'option', key, optionId: option.id, value });
    }

    // Perform the validated writes. A failure here means the engine disagrees
    // with its own descriptor, not caller misuse. There is no wire-level
    // batch write, so earlier keys in the patch may already have landed.
    for (const write of writes) {
      if (write.kind === 'mode') {
        try {
          await connection.setMode(this.internals.nativeSessionId, write.value, {
            timeoutMs: this.internals.requestTimeoutMs,
          });
        } catch (e) {
          throw this.mapConfigWireError('session/set_mode', write.key, e);
        }
      } else if (write.kind === 'model') {
        try {
          await connection.setModel(this.internals.nativeSessionId, write.value, {
            timeoutMs: this.internals.requestTimeoutMs,
          });
        } catch (e) {
          throw this.mapConfigWireError('session/set_model', write.key, e);
        }
      } else {
        try {
          await connection.setConfigOption(this.internals.nativeSessionId, write.optionId, write.value, {
            timeoutMs: this.internals.requestTimeoutMs,
          });
        } catch (e) {
          throw this.mapConfigWireError('session/set_config_option', write.key, e);
        }
      }
      // Recorded per write, after the acknowledgement: a patch is not atomic on
      // the wire, so a later key failing must not erase what the engine already
      // accepted.
      this.configTracker.recordDesired(write.key, write.value);
    }
  }

  /**
   * Read this session's configuration as two independent views.
   *
   * `desired` is what runskein wrote and the engine acknowledged; `observed` is
   * only what the engine reported by itself, with the source and time of each
   * report. A key absent from `observed` means the engine never reported it —
   * never that it agrees with `desired`, which is why the two are never merged.
   * @returns a snapshot of both views; issues no wire requests.
   */
  configState(): SessionConfigState {
    return this.configTracker.snapshot();
  }

  /**
   * Map a config key to its ConfigOption, matching an option id first and a
   * category alias second.
   * @param descriptor - the engine descriptor holding configOptions.
   * @param key - the runskein config key.
   * @returns the matching option.
   * @throws ConfigError listing the valid keys when none match.
   */
  private resolveConfigOption(descriptor: EngineDescriptor, key: string): ConfigOption {
    const category = key === 'model' ? 'model' : key === 'reasoning' ? 'thought_level' : key;
    const option =
      descriptor.configOptions.find((o) => o.id === key) ??
      descriptor.configOptions.find((o) => o.category === category);
    if (option) return option;
    // `model` counts as valid whenever it is settable, which includes the
    // engines that carry it on the models surface instead of as a config
    // option. Listing only configOptions told a claude-code caller "valid
    // keys: mode" on an engine where setConfig({model}) works — the exact
    // misreading the model surface exists to prevent.
    const validKeys = [
      ...new Set([
        ...((descriptor.modes ?? []).length > 0 ? ['mode'] : []),
        ...((descriptor.models ?? []).length > 0 ? ['model'] : []),
        ...descriptor.configOptions.map((o) => o.id),
      ]),
    ];
    throw new ConfigError({
      engineId: this.engine,
      key,
      message: `unknown config key '${key}' — valid keys: ${validKeys.join(', ') || '(none reported)'}`,
      validValues: validKeys,
    });
  }

  /**
   * Translate a refused config write into a typed error. The descriptor
   * already validated this write, so a refusal means the engine lacks the
   * method or has drifted from what it advertised — never caller misuse, which
   * is why ConfigError is not among the outcomes.
   * @param operation - the wire operation (set_mode or set_config_option).
   * @param key - the config key being written.
   * @param e - the raw rejection.
   * @returns NotSupportedError when the engine reports the method is missing,
   * otherwise an EngineOperationError.
   */
  private mapConfigWireError(operation: string, key: string, e: unknown): Error {
    if (/method not found|-32601/i.test(String(e))) {
      // Name the surface that is actually missing. Reporting every refusal as
      // 'setConfig' is what made a missing model method look like a blanket
      // config gap.
      const capability = operation.startsWith('session/set_model')
        ? 'setModel'
        : operation.startsWith('session/set_mode')
          ? 'setMode'
          : 'setConfig';
      return new NotSupportedError(this.engine, capability, this.id);
    }
    return this.engineOperationError(`${operation}(${key})`, e);
  }

  /**
   * Answer a pending question raised by the engine.
   * @param requestId - the request id carried by the 'question' event.
   * @param answer - free text, or the id of one of the offered options.
   * @throws EngineOperationError when the request id is unknown or already
   * answered.
   */
  async respond(requestId: string, answer: Answer): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) {
      throw this.engineOperationError(
        'session/respond',
        new Error(`no pending question with requestId '${requestId}'`),
      );
    }
    this.pendingQuestions.delete(requestId);
    const value = 'text' in answer ? answer.text : answer.optionId;
    pending.resolve({ action: 'accept', content: { [pending.propertyName]: value } });
    if (this.pendingQuestions.size === 0 && !this.closedFlag) {
      this.setStatus(this.turnActive ? 'running' : 'idle');
    }
    this.touchIdle();
  }

  // ── transcript & accounting ──────────────────────────────────────────────

  /**
   * Settle a `prompt_response_meta` usage report at turn close (decision 033
   * §4.2, §4.4). The declared semantics decide the fold, mirroring the
   * engine-sent path: `per-turn` makes the report this turn's value and adds
   * it into the session counter; `cumulative` replaces the session counter
   * and the turn value is the delta against the turn-open snapshot. Either
   * way the report persists as a synthesized event carrying the
   * SESSION-CUMULATIVE value — replay replaces within a segment, which is
   * only correct if the stored event carries the session total, not the turn
   * delta.
   * @param resp - the raw prompt response carrying the declared path.
   * @param mapping - the adapter's declared usage mapping.
   * @param turnOpenUsage - the session counter snapshot taken at turn open.
   */
  private settleMetaSourcedUsage(
    resp: unknown,
    mapping: UsageMapping,
    turnOpenUsage: Usage | undefined,
  ): void {
    if (mapping.source.kind !== 'prompt_response_meta') return;
    const payload = resolveUsagePath(resp, mapping.source.path);
    if (payload === undefined) return;
    if (mapping.semantics === 'per-turn') {
      const report = foldUsageReport(undefined, payload, mapping.tokens);
      if (report === undefined || Object.keys(report).length === 0) return;
      this.turnUsage = report;
      this.sessionUsage = addUsage(this.sessionUsage, report);
    } else {
      const folded = foldUsageReport(this.sessionUsage, payload, mapping.tokens);
      // Unchanged return value means the gate saw no token field: no report,
      // exactly like an engine-sent update carrying only a window gauge.
      if (folded === undefined || folded === this.sessionUsage) return;
      this.sessionUsage = folded;
      const turnValue = diffUsage(folded, turnOpenUsage);
      if (turnValue !== undefined) this.turnUsage = turnValue;
    }
    // The envelope stamps the same combined view an engine-sent usage_update
    // gets, so all three accounting surfaces stay in parity on this carrier.
    this.record(syntheticUsageUpdate(this.sessionUsage), this.combinedUsage());
  }

  /**
   * Stream this session's persisted transcript.
   * @param opts - fromSeq yields only events at or after that seq.
   * @returns the events in seq order.
   * @throws StoreError when the transcript cannot be read or a pending append
   * had failed.
   */
  transcript(opts?: { fromSeq?: number }): AsyncIterable<TranscriptEvent> {
    return this.readTranscript(opts);
  }

  /**
   * The cumulative usage observed so far, across resumes and never regressing.
   * @returns a summary carrying only the fields the engine actually reported.
   */
  usage(): UsageSummary {
    const tokens = addUsage(this.usageBaseline, this.sessionUsage);
    const summary: UsageSummary = { ...tokens };
    const combinedCost = combineCosts([this.costBaseline, this.costInfo], this.mixedCostCurrencies);
    if (combinedCost.cost !== undefined) {
      summary.cost = combinedCost.cost.cost;
      summary.currency = combinedCost.cost.currency;
    }
    return summary;
  }

  /**
   * Fold the baseline carried over from prior lives with this life's counter.
   * @returns the merged usage, or undefined when nothing was ever reported.
   */
  private combinedUsage(): Usage | undefined {
    const combined = addUsage(this.usageBaseline, this.sessionUsage);
    return Object.keys(combined).length > 0 ? combined : undefined;
  }

  private async *readTranscript(opts?: { fromSeq?: number }): AsyncIterable<TranscriptEvent> {
    await this.flushPersist();
    try {
      yield* this.internals.store.read(this.id, opts);
    } catch (e) {
      throw storeBoundaryError('read', e, { engineId: this.engine, sessionId: this.id });
    }
  }

  // ── wire handlers (called by the hub router; @internal) ──────────────────

  /**
   * Route one session/update notification: envelope it, fold any usage report,
   * queue it for persistence, and emit it to listeners.
   * @param update - the runskein-normalized session update.
   * @internal called by the hub's update router.
   */
  handleUpdate(update: SessionUpdate): void {
    // Inbound traffic is the session being used, even with no turn in flight.
    this.touchIdle();
    const event: TranscriptEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      sessionId: this.id,
      engineId: this.engine,
      update,
    };
    // Engine-initiated config reports. They are observations only: an engine
    // changing its own mode says nothing about what the host asked for, so
    // `desired` is left untouched.
    if (update.sessionUpdate === 'current_mode_update') {
      this.configTracker.recordModeUpdate(update.currentModeId);
    } else if (update.sessionUpdate === 'config_option_update') {
      this.configTracker.recordConfigOptionUpdate(update.configOptions);
    }
    if (update.sessionUpdate === 'usage_update') {
      const raw = update as unknown as Record<string, unknown>;
      // A declared non-default source is exclusive (decision 033 §4.3): an
      // engine reporting tokens through both carriers would otherwise be
      // counted twice, and both numbers would look plausible. Cost keeps its
      // own rule and is read from every usage_update regardless.
      const metaSourced = this.internals.usageMapping?.source.kind === 'prompt_response_meta';
      if (!metaSourced) {
        const folded = foldUsage(this.sessionUsage, raw, this.internals.usageMapping?.tokens);
        if (folded !== undefined && folded !== this.sessionUsage) {
          this.sessionUsage = folded;
          this.turnSawTokenReport = true;
          // The envelope carries the session-cumulative view, not the delta.
          const combined = this.combinedUsage();
          if (combined !== undefined) event.usage = combined;
        }
      }
      const cost = readCost(raw);
      if (cost) {
        if (
          (this.costBaseline !== undefined && this.costBaseline.currency !== cost.currency) ||
          (this.costInfo !== undefined && this.costInfo.currency !== cost.currency)
        ) {
          this.mixedCostCurrencies = true;
        }
        this.costInfo = cost;
      }
    }
    this.persist(event);
    this.emit('update', event);
  }

  /**
   * Answer an agent permission request through the session's policy.
   * @param params - the raw permission request payload.
   * @returns the outcome to send back to the agent.
   * @internal called by the hub's update router.
   */
  async handlePermission(
    params: PermissionRequestLike,
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const toolCall = (params['toolCall'] ?? {}) as {
      toolCallId?: string;
      title?: string | null;
      kind?: ToolKind | null;
      rawInput?: unknown;
      locations?: ToolCallLocation[] | null;
    };
    const req: PermissionRequest = {
      sessionId: this.id,
      engineId: this.engine,
      tool: toolCall.title ?? toolCall.toolCallId ?? 'unknown',
      input: toolCall.rawInput,
      // Engines are not validated at this boundary; a missing options array
      // must not throw a TypeError out of the wire handler.
      options: (params.options ?? []) as PermissionOption[],
    };
    if (toolCall.kind != null) req.kind = toolCall.kind;
    if (toolCall.locations != null) req.locations = toolCall.locations;
    // Race the policy against cancel()/close(): an interactive policy still
    // awaiting its user when the turn is cancelled must not leave the engine's
    // request_permission unanswered on the wire.
    const aborted = Symbol('permission-aborted');
    let abort!: () => void;
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      abort = () => resolve(aborted);
    });
    this.pendingPermissionAborts.add(abort);
    let decision: PermissionDecision | typeof aborted;
    try {
      decision = await Promise.race([Promise.resolve(this.internals.policy(req)), abortPromise]);
    } finally {
      this.pendingPermissionAborts.delete(abort);
    }
    if (decision === aborted) return { outcome: { outcome: 'cancelled' } };
    const outcome = decisionToOutcome(decision, req.options);
    // Emitted after the policy decided: listeners observe, they do not answer.
    this.emit('permission', req);
    return { outcome };
  }

  /**
   * Route a question raised by the engine to the 'question' listeners, and
   * resolve once respond() supplies an answer.
   * @param params - the raw question payload.
   * @returns the accept or decline response for the engine.
   * @internal called by the hub's update router.
   */
  handleQuestion(params: QuestionRequestLike): Promise<QuestionResponseLike> {
    if ((this.listeners.get('question')?.size ?? 0) === 0) {
      // Nobody to ask: decline rather than hang the engine forever.
      return Promise.resolve({ action: 'decline' });
    }
    const requestId = randomUUID();
    const schema = params.requestedSchema?.properties ?? {};
    const propertyName = Object.keys(schema)[0] ?? 'value';
    const q: QuestionRequest = {
      requestId,
      sessionId: this.id,
      engineId: this.engine,
      question: params.message ?? '',
    };
    const enumValues = schema[propertyName]?.enum;
    if (Array.isArray(enumValues)) {
      q.options = enumValues.map((v) => ({ id: v, label: v }));
    }
    return new Promise<QuestionResponseLike>((resolve) => {
      this.pendingQuestions.set(requestId, { resolve, propertyName });
      this.setStatus('awaiting-input');
      this.emit('question', q);
    });
  }

  // ── terminals ────────────────────────────────────────────────────────────

  /**
   * Run a command for the engine, once the permission policy allows it.
   *
   * Engines that delegate command execution reach this path; runskein is the one
   * running the process, so the decision goes through the same policy that
   * governs the engine's own tools rather than a second mechanism.
   * @param params - the agent's terminal/create request.
   * @returns the terminal id the agent addresses later calls to.
   * @throws `Error` when the policy refuses, the requested cwd escapes the
   *   session, or the request sets an environment variable an agent may not set.
   * @internal called by the hub's client-method router.
   */
  async handleTerminalCreate(params: TerminalRequestLike): Promise<{ terminalId: string }> {
    if (this.closedFlag) throw new Error('session is closed');
    const command = typeof params.command === 'string' ? params.command : '';
    if (command === '') throw new Error('terminal/create requires a command');
    const terminals = (this.terminals ??= new SessionTerminals(
      this.cwd,
      this.internals.envScrubExtra ?? [],
      // A finished command makes the session idle again, and nothing else
      // would restart the countdown that suspension depends on.
      () => this.touchIdle(),
    ));
    // Resolved before asking, so the policy sees the directory the command
    // would actually run in rather than the one the agent proposed.
    const cwd = terminals.resolveCwd(params.cwd);
    const args = Array.isArray(params.args) ? params.args : [];
    // Checked here rather than where it is applied, because everything below
    // this line costs something: the policy is asked, which may put a prompt in
    // front of a person, and then a process is spawned. A request that cannot
    // be honoured should cost neither.
    const outputByteLimit = params.outputByteLimit;
    if (outputByteLimit !== undefined && outputByteLimit !== null) {
      if (typeof outputByteLimit !== 'number' || !Number.isFinite(outputByteLimit) || outputByteLimit < 1) {
        throw new Error(
          `terminal/create: outputByteLimit must be a positive finite number, got ${JSON.stringify(outputByteLimit)}`,
        );
      }
    }
    // Checked before asking, and part of what is asked: the environment decides
    // which program an allowed command turns out to be, so a policy that could
    // not see it would be authorising a name rather than an execution.
    const env = authorizeTerminalEnv(params.env, this.internals.envScrubExtra ?? []);
    const request: PermissionRequest = {
      sessionId: this.id,
      engineId: this.engine,
      tool: 'terminal',
      kind: 'execute',
      input: { command, args, cwd, env },
      locations: [{ path: cwd }],
      options: [
        { optionId: 'allow', name: 'Run the command', kind: 'allow_once' },
        { optionId: 'deny', name: 'Refuse', kind: 'reject_once' },
      ],
    };
    const decision = await Promise.resolve(this.internals.policy(request));
    const outcome = decisionToOutcome(decision, request.options);
    this.emit('permission', request);
    if (outcome.outcome !== 'selected' || outcome.optionId !== 'allow') {
      throw new Error(`refused by permission policy: ${command}`);
    }
    const create: TerminalCreateParams = { command, args, cwd };
    if (env.length > 0) create.env = env;
    if (outputByteLimit != null) create.outputByteLimit = outputByteLimit;
    return { terminalId: terminals.create(create) };
  }

  /**
   * Read a terminal's retained output.
   * @param params - the agent's terminal/output request.
   * @returns output, truncation flag, and exit status once finished.
   * @internal called by the hub's client-method router.
   */
  handleTerminalOutput(params: TerminalRequestLike): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: unknown;
  }> {
    return Promise.resolve(this.requireTerminals().output(String(params.terminalId)));
  }

  /**
   * Wait for a terminal's command to exit.
   * @param params - the agent's terminal/wait_for_exit request.
   * @returns the exit status.
   * @internal called by the hub's client-method router.
   */
  handleTerminalWaitForExit(
    params: TerminalRequestLike,
  ): Promise<{ exitCode?: number | null; signal?: string | null }> {
    return this.requireTerminals().waitForExit(String(params.terminalId));
  }

  /**
   * Stop a terminal's command, keeping its output readable.
   * @param params - the agent's terminal/kill request.
   * @internal called by the hub's client-method router.
   */
  async handleTerminalKill(params: TerminalRequestLike): Promise<void> {
    await this.requireTerminals().kill(String(params.terminalId));
  }

  /**
   * Stop a terminal and forget it.
   * @param params - the agent's terminal/release request.
   * @internal called by the hub's client-method router.
   */
  async handleTerminalRelease(params: TerminalRequestLike): Promise<void> {
    await this.terminals?.release(String(params.terminalId));
  }

  private requireTerminals(): SessionTerminals {
    if (!this.terminals) throw new Error('this session has no terminals');
    return this.terminals;
  }

  /** @internal — true once close() ran (used by hub bookkeeping). */
  get isClosed(): boolean {
    return this.closedFlag;
  }

  // ── persistence plumbing ─────────────────────────────────────────────────

  /**
   * Envelope a locally-generated update, queue it for persistence, and emit it.
   *
   * RunSkein's own events reach a subscriber exactly as an engine's do. The
   * transcript is what a session can be replayed from, so a live subscriber
   * that saw a different set of events than the transcript holds would be
   * reading a different session: token accounting, the status changes runskein
   * records, and the prompt it echoed back would all be visible only after the
   * fact. Emitting here, from the same counter and in the same order as
   * `handleUpdate`, keeps the two views the same one.
   * @param update - the session update to record.
   * @param usage - runskein's cumulative token snapshot to stamp on the envelope.
   */
  private record(update: SessionUpdate, usage?: Usage): void {
    const event: TranscriptEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      sessionId: this.id,
      engineId: this.engine,
      update,
      ...(usage !== undefined ? { usage } : {}),
    };
    this.persist(event);
    this.emit('update', event);
  }

  /**
   * Append an event to the store on a serialized chain, so events land in seq
   * order. Failures are captured rather than thrown — flushPersist() surfaces
   * the first one at the next API boundary.
   * @param event - the enveloped event to persist.
   */
  private persist(event: TranscriptEvent): void {
    this.persistChain = this.persistChain
      .then(() => this.internals.store.append(event))
      .catch((e: unknown) => {
        this.persistError ??=
          e instanceof NotFoundError || e instanceof StoreError
            ? e
            : new StoreError({
                operation: 'append',
                cause: e,
                engineId: this.engine,
                sessionId: this.id,
              });
      });
  }

  /**
   * Await the pending appends and surface the first persistence failure at an
   * API boundary, so a store outage never passes silently.
   * @throws StoreError or NotFoundError captured by an earlier append.
   */
  private async flushPersist(): Promise<void> {
    await this.persistChain;
    if (this.persistError) {
      const err = this.persistError;
      this.persistError = undefined;
      throw err;
    }
  }

  /** @internal — make creation persistence part of hub.session() success. */
  async [initializeSessionPersistence](): Promise<void> {
    await this.flushPersist();
  }

  /**
   * @internal — the engine process crashed: mark this session failed and free
   * what it holds. Called from the hub's engine:crash listener, AFTER the
   * manager's restart decision, so the release cannot make a mid-turn crash
   * look idle. Idempotent: detach compare-and-deletes and release() is
   * flag-guarded, so a later close() stays safe. Freeing the reference lets
   * the (restarted) process be idle-reaped, and unregistering the routing
   * entries lets hub.session({resume: id}) recover the id instead of
   * throwing "already live".
   */
  [markEngineCrashed](): void {
    if (this.closedFlag || !this.bound || this.reactivating) return;
    this.connectionLost = true;
    if (this.statusValue !== 'failed') {
      this.setStatus('failed');
      this.record(sessionMetaUpdate({ status: 'failed' }));
    }
    this.cancelIdleCountdown?.();
    this.cancelIdleCountdown = undefined;
    // Suspend rather than detach: the session stays known to the hub so the
    // next prompt can rebuild it in place. 'failed' describes the session right
    // now — it has no engine — not a verdict that it can never run again.
    this.bound = false;
    this.internals.suspend();
  }

  /** @internal — release a session whose initial transcript append failed. */
  async [disposeFailedSessionCreation](): Promise<void> {
    this.closedFlag = true;
    let failure: Error | undefined;
    try {
      if (this.internals.capabilities.session['close'] && !this.internals.acquired.connection.isClosed) {
        await this.internals.acquired.connection.closeSession(this.internals.nativeSessionId);
      }
    } catch (e) {
      failure = this.engineOperationError('session/close', e);
    } finally {
      this.internals.detach();
      this.internals.acquired.release();
    }
    if (failure) throw failure;
  }
}
