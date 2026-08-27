/**
 * Hub — engine inventory, describe() probe, sessions, process control.
 * One update router per hub: session/update notifications and
 * permission/question requests are dispatched to the owning Session by the
 * engine's native session id.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RequestTimeoutError,
  type AcpModelState,
  type AcpModeState,
  type AcpNewSessionResult,
} from './acp/connection.js';
import { applyCapabilityOverride, type CapabilityOverride } from './acp/capabilities.js';
import type { WireObserver } from './acp/wireTrace.js';
import {
  autoAllowPermission,
  type AcpClientHandlers,
  type SessionUpdateNotification,
} from './acp/clientMethods.js';
import {
  CancelledError,
  ConfigError,
  EngineOperationError,
  NotFoundError,
  NotInstalledError,
  NotSupportedError,
  StoreError,
  UnauthenticatedError,
  storeBoundaryError,
} from './errors.js';
import { operationErrorKind } from './errorTaxonomy.js';
import { policies, type PermissionPolicy } from './permission/policy.js';
import { ProcessManager, type AcquiredEngine } from './process/manager.js';
import { Registry } from './registry.js';
import type { SessionCreationState } from './session/configState.js';
import type { OrphanSweepResult, OwnershipRegistry } from './process/ownership.js';
import { realIdleClock, type IdleClock } from './session/idleClock.js';
import { loadResumeSource, recoverAccounting, resolveResume } from './session/resume.js';
import {
  disposeFailedSessionCreation,
  initializeSessionPersistence,
  markEngineCrashed,
  Session,
  type ReactivationBinding,
  type SessionOpening,
} from './session/session.js';
import { jsonlStore } from './transcript/jsonlStore.js';
import type { DigestOptions, DigestResult } from './transcript/digest.js';
import type { TranscriptEvent } from './transcript/event.js';
import {
  foldSessionMeta,
  matchesFilter,
  type SessionFilter,
  type SessionMeta,
  type TranscriptStore,
} from './transcript/store.js';
import type { McpServerConfig, SessionUpdate } from './vocabulary.js';
import type {
  ConfigOption,
  DetectResult,
  EngineAdapter,
  EngineCleanupFailure,
  EngineCrashInfo,
  EngineDescriptor,
  EngineInfo,
  Health,
  HubEvent,
  HubOptions,
  ProviderInfo,
  RegisteredEngineInfo,
  SessionMode,
  SessionModel,
  SessionOpts,
  Unsubscribe,
  CapabilityMatrix,
} from './types.js';

/** Retries allowed within one reactivation episode when none is configured. */
const DEFAULT_REACTIVATION_ATTEMPTS = 3;

/** Ceiling for setup-class requests; what the connection layer has always used. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** How long quit() will wait for timed-out requests to settle before reporting. */
const CLEANUP_WINDOW_MS = 30_000;

/**
 * @internal Read the update router's registered keys.
 *
 * A unique symbol rather than a method name, for the same reason the Session
 * lifecycle hooks use one: `Hub` is public, and this must not be.
 *
 * It exists because whether a session's native-id routing entry is present or
 * absent cannot be observed from outside — not through the transcript, not
 * through `status`, not through any public method. Confirming it by side
 * effect would need an update to arrive for a stale id on a still-live
 * connection while a second session's fresh id happens to collide, and those
 * two conditions cannot be constructed simultaneously through the public API.
 * Without this accessor a test can only infer the router's state from
 * downstream effects, which passes just as happily when the router never
 * changed at all.
 */
export const inspectRouting: unique symbol = Symbol('inspectRouting');

/** Internal-only extension of HubOptions (test seam). */
export interface InternalHubOptions extends HubOptions {
  /** Mask-only capability override, re-exported via @runskein/conformance. */
  capabilityOverride?: CapabilityOverride;
  /**
   * Internal wire-trace seam: per-engine factory returning an observer of raw
   * JSON-RPC frames. Diagnostic only — it changes no behaviour, and both the
   * hermetic suite and the live harness use it as an oracle independent of
   * runskein's own bookkeeping.
   */
  wireObserver?: (engineId: string) => WireObserver | undefined;
  /**
   * Timer source for every session's idle countdown. Tests inject a clock they
   * can fire on demand, which is the only way to schedule a prompt against an
   * expiry deterministically.
   */
  idleClock?: IdleClock;
  /**
   * How long a timed-out request is given to settle before runskein stops waiting
   * and reports it unobserved. Defaults to 30 s; tests shorten it so the
   * never-settles path can be exercised without a 30 s wait.
   */
  cleanupWindowMs?: number;
  /**
   * Orphan-sweep seams: where ownership is recorded, how often the sweep runs,
   * the timer it runs on, and a per-run report. Tests inject all four; a real
   * host uses the shared registry and the 5-minute default.
   */
  orphanSweep?: {
    ownership?: OwnershipRegistry;
    intervalMs?: number;
    clock?: IdleClock;
    onSweep?: (result: OrphanSweepResult) => void;
  };
  /**
   * Adapters bundled as the discovery base layer (layer 1) —
   * wired by the `runskein` meta-package's createHub; workspace and
   * installed adapters override them by id.
   */
  builtins?: EngineAdapter[];
}

export class Hub {
  private readonly registry: Registry;
  private readonly manager: ProcessManager;
  private readonly store: TranscriptStore;
  private readonly defaultPolicy: PermissionPolicy;
  private readonly capabilityOverride: CapabilityOverride | undefined;
  private readonly defaultSessionIdleTimeoutMs: number | undefined;
  private readonly defaultReactivationAttempts: number;
  private readonly defaultRequestTimeoutMs: number;
  private readonly defaultTurnTimeoutMs: number | undefined;
  private readonly cleanupWindowMs: number;
  /** Compensations for timed-out requests; quit() waits on these, bounded. */
  private readonly pendingCleanups = new Set<Promise<unknown>>();
  private readonly idleClock: IdleClock;
  private describeCache = new Map<string, Promise<EngineDescriptor>>();
  /** Live sessions by runskein sessionId. */
  private readonly liveById = new Map<string, Session>();
  /** RunSkein session ids with a resume in flight; claimed before the first
   * await so two concurrent resumes of one id cannot both build. */
  private readonly resumingIds = new Set<string>();
  /** Native keys owned by an in-flight describe() probe — the only unowned
   * permission requests answered with the headless auto-allow. */
  private readonly probeNativeKeys = new Set<string>();
  /** Router: `${engineId}:${nativeSessionId}` → live Session. */
  private readonly liveByNative = new Map<string, Session>();
  /** Updates can legally arrive before the matching session/new response. */
  private readonly pendingUpdates = new Map<string, SessionUpdate[]>();
  private pendingUpdateCount = 0;
  private readonly creatingByEngine = new Map<string, number>();

  /**
   * Create a Hub wiring the registry, process manager, and transcript store.
   * @param options - adapters/adapterPaths/discovery/store/defaults, plus the
   * test-only capabilityOverride.
   */
  constructor(options: InternalHubOptions = {}) {
    this.registry = new Registry({
      ...(options.adapters ? { adapters: options.adapters } : {}),
      ...(options.adapterPaths ? { adapterPaths: options.adapterPaths } : {}),
      ...(options.discovery !== undefined ? { discovery: options.discovery } : {}),
      ...(options.builtins ? { builtins: options.builtins } : {}),
    });
    this.store = options.store ?? jsonlStore('.transcripts');
    this.defaultPolicy = options.defaults?.permissionPolicy ?? policies.allowAll;
    this.manager = new ProcessManager({
      ...(options.defaults?.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: options.defaults.idleTimeoutMs }
        : {}),
      handlers: (engineId) => this.routerHandlers(engineId),
      ...(options.wireObserver ? { wireObserver: options.wireObserver } : {}),
      ...(options.orphanSweep?.ownership ? { ownership: options.orphanSweep.ownership } : {}),
      ...(options.orphanSweep?.intervalMs !== undefined
        ? { sweepIntervalMs: options.orphanSweep.intervalMs }
        : {}),
      ...(options.orphanSweep?.clock ? { sweepClock: options.orphanSweep.clock } : {}),
      ...(options.orphanSweep?.onSweep ? { onSweep: options.orphanSweep.onSweep } : {}),
    });
    this.capabilityOverride = options.capabilityOverride;
    this.defaultSessionIdleTimeoutMs = options.defaults?.sessionIdleTimeoutMs;
    const attempts = options.defaults?.reactivationAttempts;
    if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1)) {
      throw new ConfigError({
        engineId: '(hub)',
        key: 'defaults.reactivationAttempts',
        message: `reactivationAttempts must be a positive integer, got ${String(attempts)}`,
      });
    }
    this.defaultReactivationAttempts = attempts ?? DEFAULT_REACTIVATION_ATTEMPTS;
    this.defaultRequestTimeoutMs = options.defaults?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.defaultTurnTimeoutMs = options.defaults?.turnTimeoutMs;
    this.cleanupWindowMs = options.cleanupWindowMs ?? CLEANUP_WINDOW_MS;
    this.idleClock = options.idleClock ?? realIdleClock;
    // When an engine crashes, every live session on it holds a permanently
    // stale connection: mark each failed and free what it holds. Running this
    // from the crash event (after the manager's restart decision) rather than
    // from the sessions' own turn rejections keeps the refcount readable at
    // exit time — see [markEngineCrashed].
    this.manager.on('engine:crash', ({ engineId }) => {
      for (const session of [...this.liveById.values()]) {
        if (session.engine === engineId) session[markEngineCrashed]();
      }
    });
  }

  /**
   * @internal Snapshot of the update router's keys (`engineId:nativeSessionId`).
   * Read-only: it copies, changes nothing, and issues no wire traffic.
   * @returns the registered routing keys, sorted for stable comparison.
   */
  [inspectRouting](): string[] {
    return [...this.liveByNative.keys()].sort();
  }

  /**
   * Race a session creation against its ceiling without losing the original.
   * @param creation - the in-flight request; still referenced after a timeout.
   * @param ms - the ceiling.
   * @param operation - the setup-class operation being bounded.
   * @returns the creation result.
   * @throws RequestTimeoutError once the ceiling passes.
   */
  private async boundedCreation(
    creation: Promise<AcpNewSessionResult>,
    ms: number,
    operation: 'session/new' | 'session/fork',
  ): Promise<AcpNewSessionResult> {
    let expired = false;
    const timer = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => {
        expired = true;
        resolve('timeout');
      }, ms);
      handle.unref?.();
    });
    const outcome = await Promise.race([creation.then(() => 'settled' as const), timer]);
    if (outcome === 'settled' || !expired) return creation;
    throw new RequestTimeoutError(ms, operation);
  }

  /**
   * Issue a session-creating request without losing a late engine response.
   * @param acquired - engine reference that owns the request and any cleanup.
   * @param engineId - engine id used for cleanup diagnostics.
   * @param operation - one of the ACP methods that creates a native session.
   * @param params - raw ACP request parameters.
   * @param requestMs - ceiling for the request and compensating cleanup.
   * @returns the engine's new native session result.
   * @throws RequestTimeoutError when the request exceeds requestMs.
   */
  private async createNativeSession(
    acquired: AcquiredEngine,
    engineId: string,
    operation: 'session/new' | 'session/fork',
    params: Record<string, unknown>,
    requestMs: number,
  ): Promise<AcpNewSessionResult> {
    const creation = acquired.connection.rawRequest(operation, params) as Promise<AcpNewSessionResult>;
    try {
      return await this.boundedCreation(creation, requestMs, operation);
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        this.disposeLateSession(acquired, engineId, creation, requestMs);
      }
      throw error;
    }
  }

  /**
   * Close and delete a session whose creation timed out but landed anyway.
   *
   * The caller has already been rejected, so this session has no owner; leaving
   * it would accumulate engine-side state nobody can reach. Deletion is
   * attempted only where the engine advertises it, and neither stage may report
   * success it did not achieve.
   * @param acquired - the engine reference the creation was issued on.
   * @param engineId - the engine, for diagnostics.
   * @param creation - the original request, which may still settle.
   * @param requestMs - ceiling for the compensating close/delete.
   */
  private disposeLateSession(
    acquired: AcquiredEngine,
    engineId: string,
    creation: Promise<AcpNewSessionResult>,
    requestMs: number,
  ): void {
    const work = creation.then(
      async (late) => {
        const nativeId = late.sessionId;
        const capabilities = applyCapabilityOverride(
          engineId,
          acquired.connection.capabilities,
          this.capabilityOverride?.[engineId],
        );
        if (capabilities.session['close']) {
          try {
            await acquired.connection.closeSession(nativeId, { timeoutMs: requestMs });
          } catch (error) {
            this.emitCleanupFailure({ engineId, operation: 'session/close', nativeId, error });
          }
        }
        // Attempted even when close failed: the two are independent, and the
        // engine-side session is what actually needs to stop existing.
        if (capabilities.session['delete']) {
          try {
            await acquired.connection.deleteSession(nativeId, { timeoutMs: requestMs });
          } catch (error) {
            this.emitCleanupFailure({ engineId, operation: 'session/delete', nativeId, error });
          }
        } else {
          this.emitCleanupFailure({
            engineId,
            operation: 'session/delete',
            nativeId,
            error: new NotSupportedError(engineId, 'session.delete'),
          });
        }
      },
      () => {
        // The original failed too, so there is nothing left behind to clean up.
      },
    );
    this.trackCleanup(work);
  }

  /**
   * Wait for outstanding compensations, bounded.
   *
   * Quitting while an abandoned request is still in flight is exactly the
   * ambiguity this capability exists to remove, so quit waits — but never
   * indefinitely, because the reason a compensation is outstanding is usually
   * that an engine has stopped answering. Whatever has not settled by the
   * deadline is reported rather than assumed finished; the caller's own quit
   * budget wins when it is the shorter of the two.
   * @param callerTimeoutMs - the caller's quit budget, when supplied.
   */
  private async awaitCleanups(callerTimeoutMs?: number): Promise<void> {
    if (this.pendingCleanups.size === 0) return;
    const budget = Math.min(this.cleanupWindowMs, callerTimeoutMs ?? this.cleanupWindowMs);
    const outstanding = [...this.pendingCleanups];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), budget);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([Promise.all(outstanding).then(() => 'settled' as const), expiry]);
      if (outcome === 'expired') {
        // Never recorded as success: the engine may still be working on a
        // request nobody is waiting for, and saying otherwise would hide it.
        this.emitCleanupFailure({
          engineId: '*',
          operation: 'process/quit',
          error: new Error(
            `${String(this.pendingCleanups.size)} engine request(s) had not settled after ${String(budget)}ms`,
          ),
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Hold a compensation until it settles, so quit() can wait on it.
   *
   * The set is the only record that an abandoned request is still outstanding;
   * without it a host could quit believing everything was cleaned up while an
   * engine was still working on a request nobody is waiting for.
   * @param work - the compensation to track.
   */
  private trackCleanup(work: Promise<unknown>): void {
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    this.pendingCleanups.add(tracked);
    void tracked.finally(() => this.pendingCleanups.delete(tracked));
  }

  /**
   * Report a compensation that could not be completed.
   * @param failure - engine, session, operation, native id where known, and the error.
   */
  private emitCleanupFailure(failure: EngineCleanupFailure): void {
    this.manager.emit('engine:cleanup-failed', failure);
  }

  /**
   * Convert a post-ready ACP failure into the frozen runskein error taxonomy.
   * @param adapter - the adapter that declared the error wording.
   * @param operation - the failed ACP operation.
   * @param cause - raw engine failure, including any nested causes.
   * @param sessionId - runskein session id when the operation belonged to one.
   * @returns UnauthenticatedError for auth, otherwise an EngineOperationError.
   */
  private operationError(args: {
    adapter: EngineAdapter;
    operation: string;
    cause?: unknown;
    sessionId?: string;
  }): Error {
    if (args.cause instanceof RequestTimeoutError) {
      return new EngineOperationError({
        engineId: args.adapter.id,
        operation: args.operation,
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        kind: 'timeout',
        cause: args.cause,
      });
    }
    const classification = this.registry.classifyFailure(args.adapter, args.cause);
    if (classification === 'auth') {
      return new UnauthenticatedError(
        args.adapter.id,
        this.invalidateAuthentication(args.adapter.id),
        args.cause,
      );
    }
    const kind = classification === undefined ? undefined : operationErrorKind(classification);
    return new EngineOperationError({
      engineId: args.adapter.id,
      operation: args.operation,
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(args.cause !== undefined ? { cause: args.cause } : {}),
    });
  }

  /**
   * Invalidate an engine's auth cache and ensure later recovery starts fresh.
   * @param engineId - the engine whose live request rejected its credentials.
   * @returns the last detected login hint, when the adapter supplied one.
   */
  private invalidateAuthentication(engineId: string): string | undefined {
    const invalidation = this.registry.markUnauthenticated(engineId);
    if (!invalidation.changed) return invalidation.loginHint;
    this.emitUnauthenticated(engineId);
    for (const session of [...this.liveById.values()]) {
      if (session.engine === engineId) session[markEngineCrashed]();
    }
    // The credential-refresh measurement is still deferred. Retiring this
    // process makes the conservative path explicit: a future post-rescan
    // reactivation cannot inherit an engine process that cached the dead token.
    const recycle = this.manager.quit(engineId);
    this.trackCleanup(recycle);
    void recycle.catch((error: unknown) => {
      this.emitCleanupFailure({ engineId, operation: 'process/quit', error });
    });
    return invalidation.loginHint;
  }

  /**
   * Turn a detect() authentication result into the shared cached auth state.
   * @param engineId - the adapter whose pre-flight probe found no credentials.
   * @param detectedHint - login hint reported by the current probe.
   * @returns the typed error carrying the best known login hint.
   */
  private preflightUnauthenticatedError(engineId: string, detectedHint?: string): UnauthenticatedError {
    const invalidation = this.registry.markUnauthenticated(engineId);
    if (invalidation.changed) this.emitUnauthenticated(engineId);
    return new UnauthenticatedError(engineId, invalidation.loginHint ?? detectedHint);
  }

  /** Per-engine client handlers routing wire traffic to the owning Session. */
  /**
   * Send one terminal call to the session that owns it.
   *
   * A command runs under a session's permission policy and inside its working
   * directory, so a request naming a session this hub does not own has nowhere
   * safe to run: it fails rather than falling back to a default. The probe
   * sessions of describe() are no exception — they answer questions about
   * capabilities and never need to run anything.
   * @param engineId - the engine whose connection raised the request.
   * @param params - the raw terminal params, carrying the native session id.
   * @param run - what to ask the owning session.
   * @returns whatever the session's handler returns.
   * @throws `Error` when no live session owns the request.
   */
  private routeTerminal<T>(
    engineId: string,
    params: { sessionId?: string },
    run: (session: Session) => Promise<T>,
  ): Promise<T> {
    const key = params.sessionId ? `${engineId}:${params.sessionId}` : undefined;
    const session = key ? this.liveByNative.get(key) : undefined;
    if (!session) {
      return Promise.reject(new Error(`no live session owns terminal request '${params.sessionId ?? ''}'`));
    }
    return run(session);
  }

  private routerHandlers(engineId: string): AcpClientHandlers {
    return {
      onUpdate: (n: SessionUpdateNotification) => {
        const key = `${engineId}:${n.sessionId}`;
        const update = n.update as SessionUpdate;
        const session = this.liveByNative.get(key);
        if (session) {
          session.handleUpdate(update);
          return;
        }
        if ((this.creatingByEngine.get(engineId) ?? 0) === 0) return;
        this.bufferPendingUpdate(key, update);
      },
      onPermissionRequest: (params) => {
        const key = params.sessionId ? `${engineId}:${params.sessionId}` : undefined;
        const session = key ? this.liveByNative.get(key) : undefined;
        if (session) return session.handlePermission(params);
        // Only the hub's own describe() probe sessions get the headless
        // auto-allow; any other unowned request (e.g. one racing session
        // registration) fails closed so no engine action ever bypasses the
        // caller's permission policy.
        if (key !== undefined && this.probeNativeKeys.has(key)) return autoAllowPermission(params);
        return { outcome: { outcome: 'cancelled' as const } };
      },
      onTerminal: {
        create: (params) => this.routeTerminal(engineId, params, (s) => s.handleTerminalCreate(params)),
        output: (params) => this.routeTerminal(engineId, params, (s) => s.handleTerminalOutput(params)),
        waitForExit: (params) =>
          this.routeTerminal(engineId, params, (s) => s.handleTerminalWaitForExit(params)),
        kill: (params) => this.routeTerminal(engineId, params, (s) => s.handleTerminalKill(params)),
        release: (params) => this.routeTerminal(engineId, params, (s) => s.handleTerminalRelease(params)),
      },
      onQuestion: (params) => {
        const session =
          typeof params.sessionId === 'string'
            ? this.liveByNative.get(`${engineId}:${params.sessionId}`)
            : undefined;
        return session ? session.handleQuestion(params) : { action: 'decline' };
      },
    };
  }

  private beginSessionCreation(engineId: string): void {
    this.creatingByEngine.set(engineId, (this.creatingByEngine.get(engineId) ?? 0) + 1);
  }

  private bufferPendingUpdate(key: string, update: SessionUpdate): void {
    const pending = this.pendingUpdates.get(key) ?? [];
    pending.push(update);
    this.pendingUpdates.set(key, pending);
    this.pendingUpdateCount++;
    // Over the cap, the CHATTIEST key pays: evicting by map insertion order
    // (or from the appending key) would let one flooding creation starve a
    // quieter concurrent creation's buffered updates — a transcript gap it
    // never caused.
    while (this.pendingUpdateCount > 100) {
      let victimKey = key;
      let victim = pending;
      for (const [k, arr] of this.pendingUpdates) {
        if (arr.length > victim.length) {
          victim = arr;
          victimKey = k;
        }
      }
      victim.shift();
      this.pendingUpdateCount--;
      if (victim.length === 0) this.pendingUpdates.delete(victimKey);
    }
  }

  private takePendingUpdates(key: string): SessionUpdate[] {
    const pending = this.pendingUpdates.get(key) ?? [];
    this.pendingUpdates.delete(key);
    this.pendingUpdateCount -= pending.length;
    return pending;
  }

  private discardPendingUpdates(key: string): void {
    void this.takePendingUpdates(key);
  }

  private endSessionCreation(engineId: string): void {
    const remaining = (this.creatingByEngine.get(engineId) ?? 1) - 1;
    if (remaining > 0) this.creatingByEngine.set(engineId, remaining);
    else {
      this.creatingByEngine.delete(engineId);
      const prefix = `${engineId}:`;
      for (const key of this.pendingUpdates.keys()) {
        if (key.startsWith(prefix) && !this.liveByNative.has(key)) {
          this.discardPendingUpdates(key);
        }
      }
    }
  }

  // ── inventory ────────────────────────────────────────────────────────────

  /**
   * List the registered engines. Cheap: never spawns a process, only awaits
   * each adapter's detect(). Results stay cached until rescan().
   * @returns one EngineInfo per registered adapter, plus discovery candidates
   * that failed validation.
   */
  async engines(): Promise<EngineInfo[]> {
    const adapters = await this.registry.adapters();
    const invalid = await this.registry.invalidCandidates();
    const infos: EngineInfo[] = [];
    for (const [id, adapter] of adapters) {
      let detect: DetectResult | undefined;
      try {
        detect = await this.registry.detect(id);
      } catch (error) {
        infos.push({
          id,
          installed: false,
          health: 'invalid',
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const info: RegisteredEngineInfo = {
        id,
        installed: detect?.installed ?? true, // no detect() hook = assume present
        health: this.healthFor(id, detect?.installed, detect?.authenticated),
      };
      if (detect?.version !== undefined) info.version = detect.version;
      if (detect?.authenticated !== undefined) info.authenticated = detect.authenticated;
      if (adapter.configHints !== undefined) info.configHints = adapter.configHints;
      infos.push(info);
    }
    return [...infos, ...invalid];
  }

  /**
   * Current health per engine id, combining detect and process state.
   * @returns a map of engine id to health; invalid candidates that never
   * produced an id are omitted.
   */
  async health(): Promise<Record<string, Health>> {
    const out: Record<string, Health> = {};
    for (const info of await this.engines()) {
      if (info.id !== undefined) out[info.id] = info.health;
    }
    return out;
  }

  /**
   * Invalidate the discovery, detect, and describe caches so the next read
   * re-walks everything. Running engine processes are left untouched.
   */
  async rescan(): Promise<void> {
    this.registry.rescan();
    this.describeCache = new Map();
  }

  private healthFor(
    id: string,
    installed: boolean | undefined,
    authenticated: boolean | undefined,
  ): Exclude<Health, 'invalid'> {
    if (installed === false) return 'not-installed';
    const process = this.manager.healthOf(id);
    // Auth state only masks engines that have no live/terminal process state.
    if (authenticated === false && process === 'stopped') return 'unauthenticated';
    return process;
  }

  // ── describe ─────────────────────────────────────────────────────────────

  /**
   * Probe an engine for its capabilities, modes, and config options.
   * Expensive — spawn → initialize → session/new → collect → close — so the
   * result is cached under engineId + the version reported by detect().
   * @param engineId - the adapter id to describe.
   * @returns the engine descriptor.
   * @throws NotInstalledError when the engine is unknown or not installed.
   * @throws EngineOperationError when an unclassified probe step fails on the wire.
   * @throws UnauthenticatedError when a declared auth pattern matches a probe failure.
   */
  async describe(engineId: string): Promise<EngineDescriptor> {
    const adapter = await this.registry.get(engineId);
    if (!adapter) throw new NotInstalledError(engineId, 'no such adapter registered');
    const detect = await this.registry.detect(engineId);
    if (detect?.installed === false) throw new NotInstalledError(engineId);
    const key = `${engineId}@${detect?.version ?? 'unknown'}`;
    let cached = this.describeCache.get(key);
    if (!cached) {
      cached = this.probeDescriptor(engineId);
      this.describeCache.set(key, cached);
      cached.catch(() => this.describeCache.delete(key));
    }
    return cached;
  }

  private async probeDescriptor(engineId: string): Promise<EngineDescriptor> {
    const adapter = (await this.registry.get(engineId))!;
    const processCwd = mkdtempSync(join(tmpdir(), `runskein-describe-${engineId}-`));
    const sessionCwd = mkdtempSync(join(tmpdir(), `runskein-describe-session-${engineId}-`));
    const acquired = await this.manager.acquire(adapter, { cwd: processCwd });
    let pendingKey: string | undefined;
    let creating = true;
    this.beginSessionCreation(engineId);
    try {
      const { connection } = acquired;
      const capabilities = applyCapabilityOverride(
        engineId,
        connection.capabilities,
        this.capabilityOverride?.[engineId],
      );
      const session = await connection.newSession({ cwd: sessionCwd }).catch((e: unknown) => {
        throw this.operationError({ adapter, operation: 'session/new', cause: e });
      });
      pendingKey = `${engineId}:${session.sessionId}`;
      this.probeNativeKeys.add(pendingKey);
      this.endSessionCreation(engineId);
      creating = false;
      const configOptions = mapConfigOptions(session);
      const modes = mapModes(session.modes ?? undefined);
      let providers: ProviderInfo[] | undefined;
      if (capabilities.providers) {
        try {
          providers = mapProviders(await connection.listProviders());
        } catch (e) {
          throw this.operationError({ adapter, operation: 'providers/list', cause: e });
        }
      }
      if (capabilities.session['close']) {
        try {
          await connection.closeSession(session.sessionId);
        } catch (e) {
          throw this.operationError({
            adapter,
            sessionId: session.sessionId,
            operation: 'session/close',
            cause: e,
          });
        }
      }
      const models = mapModels(session.models ?? undefined);
      const probed = configOptions.length > 0 ? configOptions : (adapter.configHints ?? []);
      const descriptor: EngineDescriptor = {
        // Creation-only keys are appended, never allowed to shadow a probed
        // option of the same id: what the engine advertises it can take at any
        // time outranks what an adapter says it can take once.
        configOptions: [...probed, ...creationOnlyOptions(adapter, probed)],
        capabilities,
        source: configOptions.length > 0 || !adapter.configHints ? 'probe' : 'hints',
      };
      if (modes !== undefined) descriptor.modes = modes;
      if (models !== undefined) descriptor.models = models;
      if (session.models?.currentModelId !== undefined) {
        descriptor.currentModel = session.models.currentModelId;
      }
      if (providers !== undefined) descriptor.providers = providers;
      return descriptor;
    } finally {
      if (creating) this.endSessionCreation(engineId);
      if (pendingKey !== undefined) {
        this.probeNativeKeys.delete(pendingKey);
        this.discardPendingUpdates(pendingKey);
      }
      acquired.release();
    }
  }

  // ── process control ──────────────────────────────────────────────────────

  /**
   * Close live sessions, then quit the engine process(es).
   * @param engineId - a single engine to quit; omit to quit all of them.
   * @param opts - optional timeout for the process quit chain.
   * @throws UnauthenticatedError when any step reports expired credentials.
   * @throws EngineOperationError or StoreError — the single failure when only
   * one step failed, otherwise an aggregate. Without auth, a StoreError from
   * session close takes precedence so callers can still tell persistence apart
   * from the wire.
   */
  async quit(engineId?: string, opts?: { timeoutMs?: number }): Promise<void> {
    // Close sessions before the process chain (stdin → SIGTERM → SIGKILL) so
    // engines get a chance to flush session state while they can still answer.
    const live = [...this.liveById.values()].filter((s) => engineId === undefined || s.engine === engineId);
    const failures: Error[] = [];
    await Promise.all(
      live.map(async (s) => {
        try {
          await s.close();
        } catch (e) {
          failures.push(e as Error);
        }
      }),
    );
    await this.awaitCleanups(opts?.timeoutMs);
    try {
      await this.manager.quit(engineId, opts);
    } catch (e) {
      failures.push(
        e instanceof EngineOperationError
          ? e
          : new EngineOperationError({
              engineId: engineId ?? '*',
              operation: 'process/quit',
              cause: e,
            }),
      );
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const authenticationFailure = failures.find((failure) => failure instanceof UnauthenticatedError) as
        UnauthenticatedError | undefined;
      if (authenticationFailure) {
        throw new UnauthenticatedError(
          authenticationFailure.engineId,
          authenticationFailure.loginHint,
          new AggregateError(failures, 'multiple failures while quitting'),
        );
      }
      const storeFailure = failures.find((failure) => failure instanceof StoreError) as
        StoreError | undefined;
      if (storeFailure) {
        throw new StoreError({
          operation: storeFailure.operation,
          cause: new AggregateError(failures, 'multiple failures while quitting'),
          ...(storeFailure.engineId !== undefined ? { engineId: storeFailure.engineId } : {}),
          ...(storeFailure.sessionId !== undefined ? { sessionId: storeFailure.sessionId } : {}),
        });
      }
      throw new EngineOperationError({
        engineId: engineId ?? '*',
        operation: 'hub/quit',
        cause: new AggregateError(failures, 'multiple failures while quitting'),
      });
    }
  }

  /**
   * Subscribe to a hub-level engine lifecycle event.
   * @param event - the event name.
   * @param cb - the listener.
   * @returns a function that removes the listener.
   */
  on(event: 'engine:crash', cb: (info: EngineCrashInfo) => void): Unsubscribe;
  on(event: 'engine:restarted', cb: (info: { engineId: string }) => void): Unsubscribe;
  on(event: 'engine:unauthenticated', cb: (info: { engineId: string }) => void): Unsubscribe;
  on(event: 'engine:cleanup-failed', cb: (info: EngineCleanupFailure) => void): Unsubscribe;
  on(event: HubEvent, cb: never): Unsubscribe {
    return this.manager.on(event as 'engine:crash', cb);
  }

  // ── sessions ──────────────────────────────────────────

  /**
   * Create a session on an engine, or resume a previously stored one.
   * @param opts - engine, cwd, resume id, mcpServers, systemInstructions,
   * permission policy, and initial config.
   * @returns the live session.
   * @throws NotInstalledError when the engine is unknown or absent.
   * @throws UnauthenticatedError when the engine reports no credentials.
   * @throws NotSupportedError when an mcpServers transport is not advertised.
   * @throws NotFoundError when the resume id has no stored transcript.
   * @throws ConfigError when an initial config key or value is invalid.
   * @throws EngineOperationError when session/new or the resume chain fails.
   */
  async session(opts: SessionOpts): Promise<Session> {
    if (
      opts.resume !== undefined &&
      (this.liveById.has(opts.resume) || this.resumingIds.has(opts.resume))
    ) {
      throw new EngineOperationError({
        engineId: opts.engine,
        sessionId: opts.resume,
        operation: 'session/resume',
        cause: new Error('session is already live — use hub.attach() instead of resume'),
      });
    }
    // Claim the resume id before the first await: the liveById guard alone is
    // check-then-act across several awaits, so two concurrent resumes of the
    // same id would otherwise both pass and build duplicate sessions appending
    // to one transcript.
    if (opts.resume !== undefined) this.resumingIds.add(opts.resume);
    try {
      return await this.createSession(opts);
    } finally {
      if (opts.resume !== undefined) this.resumingIds.delete(opts.resume);
    }
  }

  private async createSession(opts: SessionOpts): Promise<Session> {
    // Fail-fast validations that must not cost an engine spawn: engine
    // validity first (cheap detect), then an unknown resume id. Undeclared MCP
    // transports can only be checked after acquire, where the measured
    // capability matrix exists.
    const { adapter } = await this.usableAdapter(opts.engine);
    // Split before spawning anything: a creation-only key with an unusable
    // value must be a ConfigError the caller sees instead of an engine process
    // the caller pays for. The rest is applied after creation as it always was.
    const { creationTime, afterCreation } = splitCreationConfig(adapter, opts.config);
    // Built once and reused: the same object rides session/new, the rebuilt
    // resume tier, and every later reactivation that has to create a session.
    // Anything in it can only be delivered at creation, so a rebuild that
    // dropped it would silently lose it with no write able to put it back.
    const meta = creationMeta(adapter, opts.systemInstructions, creationTime);
    const resumeSource =
      opts.resume !== undefined ? await loadResumeSource(this.store, opts.resume, opts.engine) : undefined;
    const acquired = await this.manager.acquire(adapter, { cwd: opts.cwd });
    let builtSession: Session | undefined;
    let creating = true;
    this.beginSessionCreation(opts.engine);
    try {
      // mcpServers are never silently ignored: a server whose transport the
      // engine did not advertise raises a typed NotSupportedError before any
      // session/new is sent. Checked against the masked matrix so a
      // capabilityOverride is honoured.
      if (opts.mcpServers && opts.mcpServers.length > 0) {
        this.assertMcpSupported(
          adapter.id,
          applyCapabilityOverride(
            adapter.id,
            acquired.connection.capabilities,
            this.capabilityOverride?.[adapter.id],
          ),
          opts.mcpServers,
        );
      }
      let nativeSessionId: string;
      let sessionId: string | undefined;
      let opening: SessionOpening | undefined;
      let creationState: SessionCreationState | undefined;
      if (resumeSource !== undefined) {
        const outcome = await resolveResume({
          engineId: adapter.id,
          resumeId: opts.resume!,
          cwd: opts.cwd,
          ...(opts.mcpServers ? { mcpServers: opts.mcpServers as unknown[] } : {}),
          ...(meta !== undefined ? { creationMeta: meta } : {}),
          connection: acquired.connection,
          requestTimeoutMs: opts.requestTimeoutMs ?? this.defaultRequestTimeoutMs,
          newSession: (params) =>
            this.createNativeSession(
              acquired,
              opts.engine,
              'session/new',
              params,
              opts.requestTimeoutMs ?? this.defaultRequestTimeoutMs,
            ),
          capabilities: applyCapabilityOverride(
            adapter.id,
            acquired.connection.capabilities,
            this.capabilityOverride?.[adapter.id],
          ),
          store: this.store,
          source: resumeSource,
        }).catch((e: unknown) => {
          // Store absence/failure keeps its typed identity; wire failures of
          // the last-resort tier become EngineOperationError.
          if (e instanceof NotFoundError || e instanceof StoreError) throw e;
          throw this.operationError({
            adapter,
            sessionId: opts.resume!,
            operation: 'session/resume',
            cause: e,
          });
        });
        nativeSessionId = outcome.nativeSessionId;
        sessionId = opts.resume; // runskein identity stays stable whichever resume tier ran
        creationState = outcome.creationState;
        opening = {
          kind: 'resume',
          tier: outcome.tier,
          initialSeq: outcome.initialSeq,
          ...(outcome.preamble !== undefined ? { preamble: outcome.preamble } : {}),
          ...(outcome.baselineUsage !== undefined ? { baselineUsage: outcome.baselineUsage } : {}),
          ...(outcome.baselineCost !== undefined ? { baselineCost: outcome.baselineCost } : {}),
          ...(outcome.mixedCostCurrencies === true ? { mixedCostCurrencies: true } : {}),
          ...(outcome.initialUsage !== undefined ? { initialUsage: outcome.initialUsage } : {}),
          ...(outcome.initialCost !== undefined ? { initialCost: outcome.initialCost } : {}),
        };
      } else {
        const requestMs = opts.requestTimeoutMs ?? this.defaultRequestTimeoutMs;
        // Issued WITHOUT the connection's own timeout, and raced here instead.
        // `withTimeout` rejects with a fresh error and drops the underlying
        // request, so a session that arrives late becomes unobservable — and an
        // engine-side session nobody can see is one nobody can clean up. Owning
        // the race keeps a handle on the original.
        const native = await this.createNativeSession(
          acquired,
          opts.engine,
          'session/new',
          {
            cwd: opts.cwd,
            mcpServers: (opts.mcpServers as unknown[]) ?? [],
            ...(meta !== undefined ? { _meta: meta } : {}),
          },
          requestMs,
        ).catch((e: unknown) => {
          // Never retried automatically: session/new is not idempotent, and a
          // retry after a timeout is how one caller ends up owning two engine
          // sessions. If the original still lands, dispose of it instead.
          if (e instanceof RequestTimeoutError) {
            throw new EngineOperationError({
              engineId: opts.engine,
              operation: 'session/new',
              kind: 'timeout',
              cause: e,
            });
          }
          throw this.operationError({ adapter, operation: 'session/new', cause: e });
        });
        nativeSessionId = native.sessionId;
        creationState = { state: native, source: 'session/new' };
      }
      const session = this.buildSession({
        adapter,
        acquired,
        nativeSessionId,
        cwd: opts.cwd,
        ...(meta !== undefined ? { creationMeta: meta } : {}),
        policy: opts.permissionPolicy ?? this.defaultPolicy,
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers as unknown[] } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(opening !== undefined ? { opening } : {}),
        ...(creationState !== undefined ? { creationState } : {}),
        ...(opts.sessionIdleTimeoutMs !== undefined
          ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
          : {}),
        ...(opts.reactivationAttempts !== undefined
          ? { reactivationAttempts: opts.reactivationAttempts }
          : {}),
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
        ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
      });
      builtSession = session;
      this.endSessionCreation(opts.engine);
      creating = false;
      await this.ensureSessionPersisted(session);
      if (Object.keys(afterCreation).length > 0) {
        // Fail fast on invalid config, closing the half-built session so no
        // engine-side session is left dangling. Creation-only keys are not
        // here: they already rode the creation request, and writing them again
        // is exactly what the engine refuses.
        try {
          await session.setConfig(afterCreation);
        } catch (e) {
          try {
            await session.close();
          } catch (cleanupFailure) {
            if (e instanceof UnauthenticatedError) {
              throw new UnauthenticatedError(
                e.engineId,
                e.loginHint,
                new AggregateError([e.cause ?? e, cleanupFailure], 'config and cleanup failed'),
              );
            }
            throw new EngineOperationError({
              engineId: opts.engine,
              sessionId: session.id,
              operation: 'session/create',
              cause: new AggregateError([e, cleanupFailure], 'config and cleanup failed'),
            });
          }
          throw e;
        }
      }
      return session;
    } catch (e) {
      if (creating) this.endSessionCreation(opts.engine);
      if (!builtSession?.isClosed) acquired.release();
      throw e;
    }
  }

  /**
   * Attach to a session: the live handle when it is still open, otherwise a
   * read-only view rebuilt from the stored transcript.
   * @param sessionId - the runskein session id.
   * @returns the session handle.
   * @throws NotFoundError when no such session exists.
   * @throws StoreError when the transcript cannot be read.
   */
  async attach(sessionId: string): Promise<Session> {
    const live = this.liveById.get(sessionId);
    if (live) return live; // every attach shares one handle, so all observe the same updates
    // Otherwise: a read-only view over the transcript, engine-independent and
    // never spawning. To continue the conversation, use session({resume}).
    const events: TranscriptEvent[] = [];
    try {
      for await (const e of this.store.read(sessionId)) events.push(e);
    } catch (e) {
      throw storeBoundaryError('read', e, { sessionId });
    }
    if (events.length === 0) {
      throw new NotFoundError({ resource: 'session', resourceId: sessionId });
    }
    const meta = foldSessionMeta(events)!;
    const accounting = recoverAccounting(events);
    return new Session({
      sessionId,
      engineId: meta.engineId,
      cwd: meta.cwd,
      nativeSessionId: '',
      // Never touched: every mutating path is guarded by the detached
      // opening's closed flag before reaching the connection.
      acquired: {
        engineId: meta.engineId,
        connection: undefined as unknown as AcquiredEngine['connection'],
        release: () => {},
      },
      store: this.store,
      policy: this.defaultPolicy,
      capabilities: { loadSession: false, session: {}, prompt: {}, mcp: {}, providers: false },
      reactivationAttempts: this.defaultReactivationAttempts,
      idleClock: this.idleClock,
      requestTimeoutMs: this.defaultRequestTimeoutMs,
      cleanupWindowMs: this.cleanupWindowMs,
      // A detached view owns no connection, so it can neither time out a
      // request nor leave one needing compensation.
      trackCleanup: () => {},
      reportCleanupFailure: () => {},
      // A detached view owns no engine reference and counts down no idle timer,
      // so there is nothing to give back and nothing to revive. Both are
      // unreachable: the detached opening marks the session closed, which every
      // mutating path rejects on first.
      suspend: () => {},
      reactivate: () => Promise.reject(new CancelledError(meta.engineId, sessionId)),
      // Unreachable: setConfig() rejects on the detached (closed) flag first.
      describe: () => Promise.reject(new CancelledError(meta.engineId, sessionId)),
      opening: {
        kind: 'detached',
        status: meta.status,
        initialSeq: events.reduce((m, e) => Math.max(m, e.seq), 0),
        ...(accounting.baselineUsage !== undefined ? { baselineUsage: accounting.baselineUsage } : {}),
        ...(accounting.baselineCost !== undefined ? { baselineCost: accounting.baselineCost } : {}),
        ...(accounting.mixedCostCurrencies === true ? { mixedCostCurrencies: true } : {}),
        ...(accounting.currentUsage !== undefined ? { initialUsage: accounting.currentUsage } : {}),
        ...(accounting.currentCost !== undefined ? { initialCost: accounting.currentCost } : {}),
      },
      detach: () => {},
      forkFactory: () => Promise.reject(new NotSupportedError(meta.engineId, 'fork', sessionId)),
    });
  }

  /**
   * List sessions from the store, overlaid with live status where a session is
   * still open.
   * @param filter - optional engine/status/cwd/time filtering.
   * @returns the matching sessions.
   * @throws StoreError when the store cannot be listed.
   */
  async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
    // The local store is authoritative, but it only persists creation and
    // terminal transitions — so a live session's in-memory status wins.
    let metas: SessionMeta[];
    try {
      metas = await this.store.sessions();
    } catch (e) {
      throw storeBoundaryError('sessions', e);
    }
    const overlaid = metas.map((m) => {
      const live = this.liveById.get(m.sessionId);
      return live ? { ...m, status: live.status } : m;
    });
    return overlaid.filter((m) => matchesFilter(m, filter));
  }

  /** Read-only transcript access: stream, digest, or export a session. */
  readonly transcripts: {
    get: (sessionId: string) => AsyncIterable<TranscriptEvent>;
    digest: TranscriptStore['digest'];
    export: (sessionId: string, format: 'jsonl' | 'markdown') => Promise<string>;
  } = {
    get: (sessionId: string): AsyncIterable<TranscriptEvent> => this.readTranscript(sessionId, 'read'),
    digest: this.digestTranscript.bind(this) as TranscriptStore['digest'],
    export: async (sessionId: string, format: 'jsonl' | 'markdown'): Promise<string> => {
      const events: TranscriptEvent[] = [];
      for await (const e of this.readTranscript(sessionId, 'export')) events.push(e);
      if (format === 'jsonl') return events.map((e) => JSON.stringify(e)).join('\n');
      return renderMarkdown(events);
    },
  };

  /**
   * Read one digest while keeping custom-store failures inside the typed boundary.
   * @param sessionId - transcript to digest.
   * @param opts - optional structured format and truncation settings.
   * @returns the selected text or structured digest representation.
   * @throws NotFoundError when the transcript does not exist.
   * @throws StoreError when the store cannot build the digest.
   */
  private async digestTranscript(sessionId: string, opts?: DigestOptions): Promise<DigestResult> {
    try {
      return opts === undefined
        ? await this.store.digest(sessionId)
        : await this.store.digest(sessionId, opts);
    } catch (e) {
      throw storeBoundaryError('digest', e, { sessionId });
    }
  }

  private async *readTranscript(
    sessionId: string,
    operation: 'read' | 'export',
  ): AsyncIterable<TranscriptEvent> {
    try {
      yield* this.store.read(sessionId);
    } catch (e) {
      throw storeBoundaryError(operation, e, { sessionId });
    }
  }

  /**
   * Reject mcpServers whose transport the engine did not advertise.
   * @param engineId - the engine id, for error provenance.
   * @param capabilities - the masked capability matrix.
   * @param servers - the configured MCP servers.
   * @throws NotSupportedError for a transport the engine lacks.
   */
  private assertMcpSupported(
    engineId: string,
    capabilities: CapabilityMatrix,
    servers: McpServerConfig[],
  ): void {
    for (const server of servers) {
      // McpServerStdio is a local process the engine spawns — no transport
      // capability gates it. http/sse/acp are negotiated transports.
      const transport = 'type' in server ? server.type : undefined;
      if (transport !== undefined && capabilities.mcp[transport] !== true) {
        throw new NotSupportedError(engineId, `mcp:${transport}`);
      }
    }
  }

  private async usableAdapter(engineId: string): Promise<{ adapter: EngineAdapter }> {
    const adapter = await this.registry.get(engineId);
    if (!adapter) throw new NotInstalledError(engineId, 'no such adapter registered');
    const detect = await this.registry.detect(engineId);
    if (detect?.installed === false) throw new NotInstalledError(engineId);
    if (detect?.authenticated === false) {
      throw this.preflightUnauthenticatedError(engineId, detect.loginHint);
    }
    return { adapter };
  }

  private emitUnauthenticated(engineId: string): void {
    this.manager.emit('engine:unauthenticated', { engineId });
  }

  private buildSession(args: {
    adapter: EngineAdapter;
    acquired: AcquiredEngine;
    nativeSessionId: string;
    cwd: string;
    policy: PermissionPolicy;
    mcpServers?: unknown[];
    /** Present on resume: the stable runskein id being restored. */
    sessionId?: string;
    opening?: SessionOpening;
    creationState?: SessionCreationState;
    /** `_meta` this session was created with; a rebuild must send it again. */
    creationMeta?: Record<string, unknown>;
    sessionIdleTimeoutMs?: number;
    reactivationAttempts?: number;
    requestTimeoutMs?: number;
    turnTimeoutMs?: number;
  }): Session {
    const engineId = args.adapter.id;
    const sessionId = args.sessionId ?? randomUUID();
    // Mutable because reactivation replaces the engine reference and can land
    // on a different engine-side id (the rebuilt tier creates a fresh one).
    // Every closure below must act on the binding the session is CURRENTLY on,
    // never the one it happened to start with.
    const live = {
      acquired: args.acquired,
      nativeSessionId: args.nativeSessionId,
      nativeKey: `${engineId}:${args.nativeSessionId}`,
    };
    const nativeKey = live.nativeKey;
    const idleMs = args.sessionIdleTimeoutMs ?? this.defaultSessionIdleTimeoutMs;
    const turnMs = args.turnTimeoutMs ?? this.defaultTurnTimeoutMs;
    const capabilities = applyCapabilityOverride(
      engineId,
      args.acquired.connection.capabilities,
      this.capabilityOverride?.[engineId],
    );
    const session: Session = new Session({
      sessionId,
      engineId,
      cwd: args.cwd,
      nativeSessionId: args.nativeSessionId,
      acquired: args.acquired,
      store: this.store,
      policy: args.policy,
      capabilities,
      describe: () => this.describe(engineId),
      ...(args.opening !== undefined ? { opening: args.opening } : {}),
      ...(args.creationState !== undefined ? { creationState: args.creationState } : {}),
      ...(idleMs !== undefined ? { sessionIdleTimeoutMs: idleMs } : {}),
      reactivationAttempts: args.reactivationAttempts ?? this.defaultReactivationAttempts,
      idleClock: this.idleClock,
      requestTimeoutMs: args.requestTimeoutMs ?? this.defaultRequestTimeoutMs,
      cleanupWindowMs: this.cleanupWindowMs,
      // Commands run for the engine get the same environment hygiene the
      // engine's own process got; a marker scrubbed for one and not the other
      // would leak straight back in through a terminal.
      ...(args.adapter.envScrubExtra !== undefined ? { envScrubExtra: args.adapter.envScrubExtra } : {}),
      ...(args.adapter.usage !== undefined ? { usageMapping: args.adapter.usage } : {}),
      ...(turnMs !== undefined ? { turnTimeoutMs: turnMs } : {}),
      trackCleanup: (work) => this.trackCleanup(work),
      reportCleanupFailure: (failure) => this.emitCleanupFailure({ engineId, sessionId, ...failure }),
      classifyFailure: (failure) => this.registry.classifyFailure(args.adapter, failure),
      markUnauthenticated: () => this.invalidateAuthentication(engineId),
      suspend: () => {
        // Routing goes, the identity stays: a suspended session is still the
        // hub's, so attach() finds it and a concurrent resume of the same id is
        // still refused. Only liveByNative is dropped, because there is no
        // engine-side session left to route to.
        if (this.liveByNative.get(live.nativeKey) === session) {
          this.liveByNative.delete(live.nativeKey);
        }
        live.acquired.release();
      },
      reactivate: () =>
        this.reactivateSession({
          session,
          sessionId,
          live,
          adapter: args.adapter,
          cwd: args.cwd,
          requestTimeoutMs: args.requestTimeoutMs ?? this.defaultRequestTimeoutMs,
          ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
          ...(args.creationMeta ? { creationMeta: args.creationMeta } : {}),
        }),
      detach: () => {
        // Compare-and-delete: a stale duplicate (native-id reuse, raced
        // resume) must not unregister a newer live session under the same key.
        if (this.liveById.get(sessionId) === session) this.liveById.delete(sessionId);
        if (this.liveByNative.get(live.nativeKey) === session) {
          this.liveByNative.delete(live.nativeKey);
        }
      },
      forkFactory: async () => {
        this.beginSessionCreation(engineId);
        let forkedNativeId: string | undefined;
        let forkedAcquire: AcquiredEngine | undefined;
        let forked: Session | undefined;
        try {
          const result = await this.createNativeSession(
            live.acquired,
            engineId,
            'session/fork',
            {
              sessionId: live.nativeSessionId,
              cwd: args.cwd,
              mcpServers: args.mcpServers ?? [],
            },
            args.requestTimeoutMs ?? this.defaultRequestTimeoutMs,
          ).catch((e: unknown) => {
            throw this.operationError({
              adapter: args.adapter,
              sessionId,
              operation: 'session/fork',
              cause: e,
            });
          });
          forkedNativeId = result.sessionId;
          forkedAcquire = await this.manager.acquire(args.adapter, { cwd: args.cwd });
          forked = this.buildSession({
            adapter: args.adapter,
            acquired: forkedAcquire,
            nativeSessionId: forkedNativeId,
            cwd: args.cwd,
            policy: args.policy,
            ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
            // A fork inherits what its parent was created with, so a later
            // rebuild of the fork sends the same thing. Without this the copy
            // silently differs from the original the first time it recovers.
            ...(args.creationMeta ? { creationMeta: args.creationMeta } : {}),
          });
          await this.ensureSessionPersisted(forked);
          return forked;
        } catch (e) {
          if (!forked?.isClosed) forkedAcquire?.release();
          throw e;
        } finally {
          this.endSessionCreation(engineId);
          if (forkedNativeId !== undefined && (!forked || forked.isClosed)) {
            this.discardPendingUpdates(`${engineId}:${forkedNativeId}`);
          }
        }
      },
    });
    this.liveById.set(sessionId, session);
    this.liveByNative.set(nativeKey, session);
    if (args.opening?.kind === 'resume' && args.opening.tier !== 'rebuilt') {
      // The native and load tiers continue an EXISTING engine session, so
      // anything buffered for it is history replay or stray pre-registration
      // traffic that the local store already holds — re-persisting it would
      // duplicate the transcript. Discarding here, at the registration point,
      // keeps that true even if the code between resolveResume() and
      // registration later gains an await. The rebuilt tier runs on a FRESH
      // native session, so its buffered updates are genuinely new and are
      // delivered like any other early updates.
      this.discardPendingUpdates(nativeKey);
    } else {
      for (const update of this.takePendingUpdates(nativeKey)) {
        session.handleUpdate(update);
      }
    }
    return session;
  }

  /**
   * Re-establish a suspended or crashed session on an engine.
   *
   * The single seam through which recovery reaches an engine: acquire, walk the
   * resume chain, re-register routing under whichever engine-side id the chain
   * produced. Whether recovery should reuse a live process or force a fresh one
   * is an open question, and confining it here keeps that a local change.
   * @param args - the session, its runskein id, its mutable binding, and launch inputs.
   * @returns the new binding for the session to adopt.
   * @throws EngineOperationError when acquire or the resume chain fails; the
   * engine reference is released before the failure propagates.
   */
  private async reactivateSession(args: {
    session: Session;
    sessionId: string;
    live: { acquired: AcquiredEngine; nativeSessionId: string; nativeKey: string };
    adapter: EngineAdapter;
    cwd: string;
    requestTimeoutMs: number;
    mcpServers?: unknown[];
    creationMeta?: Record<string, unknown>;
  }): Promise<ReactivationBinding> {
    const engineId = args.adapter.id;
    const detect = await this.registry.detect(engineId);
    if (detect?.authenticated === false) {
      throw this.preflightUnauthenticatedError(engineId, detect.loginHint);
    }
    // Loaded before acquiring so a missing transcript fails without a spawn.
    const source = await loadResumeSource(this.store, args.sessionId, engineId);
    const acquired = await this.manager.acquire(args.adapter, { cwd: args.cwd });
    try {
      if (acquired.connection.isClosed) {
        // The engine died and the manager has not seen the exit yet, so it is
        // still handing out the dead connection. Fail this attempt rather than
        // rebuilding onto a corpse; the retry runs after the exit lands and
        // gets the restarted process.
        throw new EngineOperationError({
          engineId,
          sessionId: args.sessionId,
          operation: 'session/reactivate',
          cause: new Error('engine connection is closed; the crash has not been processed yet'),
        });
      }
      const capabilities = applyCapabilityOverride(
        engineId,
        acquired.connection.capabilities,
        this.capabilityOverride?.[engineId],
      );
      this.beginSessionCreation(engineId);
      let outcome;
      try {
        outcome = await resolveResume({
          engineId,
          resumeId: args.sessionId,
          cwd: args.cwd,
          connection: acquired.connection,
          requestTimeoutMs: args.requestTimeoutMs,
          newSession: (params) =>
            this.createNativeSession(acquired, engineId, 'session/new', params, args.requestTimeoutMs),
          capabilities,
          store: this.store,
          source,
          ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
          ...(args.creationMeta ? { creationMeta: args.creationMeta } : {}),
        });
      } catch (e) {
        throw this.operationError({
          adapter: args.adapter,
          sessionId: args.sessionId,
          operation: 'session/reactivate',
          cause: e,
        });
      } finally {
        this.endSessionCreation(engineId);
      }

      // Re-register routing under the id the chain actually produced, dropping
      // the old key first so a rebuilt tier's fresh id does not leave a stale
      // entry pointing at this session.
      if (this.liveByNative.get(args.live.nativeKey) === args.session) {
        this.liveByNative.delete(args.live.nativeKey);
      }
      const nativeKey = `${engineId}:${outcome.nativeSessionId}`;
      args.live.acquired = acquired;
      args.live.nativeSessionId = outcome.nativeSessionId;
      args.live.nativeKey = nativeKey;
      this.liveByNative.set(nativeKey, args.session);
      if (outcome.tier === 'rebuilt') {
        // A fresh engine session, so anything buffered for it is genuinely new.
        for (const update of this.takePendingUpdates(nativeKey)) args.session.handleUpdate(update);
      } else {
        // Continuing an existing engine session: buffered traffic is replay the
        // local store already holds, and re-persisting it would duplicate.
        this.discardPendingUpdates(nativeKey);
      }

      return {
        acquired,
        nativeSessionId: outcome.nativeSessionId,
        capabilities,
        tier: outcome.tier,
        ...(outcome.preamble !== undefined ? { preamble: outcome.preamble } : {}),
        ...(outcome.creationState !== undefined ? { creationState: outcome.creationState } : {}),
      };
    } catch (e) {
      acquired.release();
      throw e;
    }
  }

  private async ensureSessionPersisted(session: Session): Promise<void> {
    try {
      await session[initializeSessionPersistence]();
    } catch (storeFailure) {
      try {
        await session[disposeFailedSessionCreation]();
      } catch (cleanupFailure) {
        throw storeBoundaryError(
          'append',
          new AggregateError([storeFailure, cleanupFailure], 'session creation cleanup failed'),
          { engineId: session.engine, sessionId: session.id },
        );
      }
      throw storeFailure;
    }
  }
}

/**
 * Construct a Hub.
 * @param options - hub options; see HubOptions.
 * @returns the hub.
 */
export function createHub(options: HubOptions = {}): Hub {
  return new Hub(options);
}

// ── session/new → descriptor mapping ───────────────────────────────────────

/** Map the UNSTABLE providers/list wire shape into runskein's ProviderInfo. */
function mapProviders(response: Record<string, unknown>): ProviderInfo[] {
  const raw = Array.isArray(response['providers']) ? response['providers'] : [];
  const out: ProviderInfo[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as Record<string, unknown>;
    if (typeof p['providerId'] !== 'string') continue;
    const info: ProviderInfo = {
      id: p['providerId'],
      protocols: Array.isArray(p['supported'])
        ? (p['supported'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
      required: p['required'] === true,
    };
    const current = p['current'];
    if (typeof current === 'object' && current !== null) {
      const c = current as { apiType?: unknown; baseUrl?: unknown };
      if (typeof c.apiType === 'string' && typeof c.baseUrl === 'string') {
        info.current = { apiType: c.apiType, baseUrl: c.baseUrl };
      }
    }
    if (typeof p['_meta'] === 'object' && p['_meta'] !== null) {
      info.metadata = p['_meta'] as Record<string, unknown>;
    }
    out.push(info);
  }
  return out;
}

/**
 * Config options synthesised from an adapter's creation-time declarations.
 *
 * These describe settings the engine takes only while its session is built, so
 * they cannot be probed — the engine never advertises them. Reporting them is
 * what lets a host offer the setting at all instead of learning it exists from
 * a rejected write.
 * @param adapter - the engine adapter, which may declare none.
 * @param probed - options the engine advertised, which win on an id clash.
 * @returns the synthesised options, in declaration order.
 */
function creationOnlyOptions(adapter: EngineAdapter, probed: ConfigOption[]): ConfigOption[] {
  const declared = adapter.creationConfig;
  if (declared === undefined) return [];
  const taken = new Set(probed.map((o) => o.id));
  return Object.entries(declared)
    .filter(([key]) => !taken.has(key))
    .map(([key, spec]) => ({
      id: key,
      name: key,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      // The runskein key doubles as the category: these are declared under runskein's
      // own vocabulary, not an engine option id.
      category: key === 'reasoning' ? ('thought_level' as const) : key,
      type: 'select' as const,
      options: Object.keys(spec.values).map((value) => ({ value, name: value })),
      settable: 'creation' as const,
    }));
}

/**
 * Split a config patch into what rides the creation request and what is
 * written after the session exists.
 *
 * Validated here rather than at the write, because the write for a
 * creation-time key never happens: the value is serialised into `session/new`,
 * and an engine that does not understand it has no way to say so. A value the
 * adapter never declared is a ConfigError before anything is spawned.
 * @param adapter - the engine adapter and its declarations.
 * @param config - the caller's patch, if any.
 * @returns the two groups, each possibly empty.
 * @throws `ConfigError` when a creation-time key carries an undeclared value.
 */
function splitCreationConfig(
  adapter: EngineAdapter,
  config: Record<string, string | boolean> | undefined,
): {
  creationTime: Record<string, string | number | boolean>;
  afterCreation: Record<string, string | boolean>;
} {
  const creationTime: Record<string, string | number | boolean> = {};
  const afterCreation: Record<string, string | boolean> = {};
  const declared = adapter.creationConfig;
  for (const [key, value] of Object.entries(config ?? {})) {
    const spec = declared?.[key];
    if (spec === undefined) {
      afterCreation[key] = value;
      continue;
    }
    const mapped = spec.values[String(value)];
    if (mapped === undefined) {
      const valid = Object.keys(spec.values);
      throw new ConfigError({
        engineId: adapter.id,
        key,
        message: `invalid ${key} '${String(value)}' — valid values: ${valid.join(', ')}`,
        validValues: valid,
      });
    }
    creationTime[key] = mapped;
  }
  return { creationTime, afterCreation };
}

/**
 * Build the `_meta` for a session-creating request.
 *
 * Two unrelated things ride the same object: runskein's own systemInstructions,
 * namespaced so an engine can ignore it, and whatever creation-time config the
 * adapter declared, written at the path that adapter names. Absent both, no
 * `_meta` is sent at all — an empty object is a different message.
 * @param adapter - the engine adapter and its declarations.
 * @param systemInstructions - runskein's creation-time instructions, if any.
 * @param creationTime - already-validated creation-only values by runskein key.
 * @returns the meta object, or undefined when there is nothing to send.
 */
function creationMeta(
  adapter: EngineAdapter,
  systemInstructions: string | undefined,
  creationTime: Record<string, string | number | boolean>,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (systemInstructions !== undefined) {
    meta['runskein.dev/systemInstructions'] = systemInstructions;
  }
  for (const [key, value] of Object.entries(creationTime)) {
    const path = adapter.creationConfig?.[key]?.meta;
    if (path === undefined || path.length === 0) continue;
    let cursor = meta;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      cursor[segment] = typeof next === 'object' && next !== null ? next : {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = value;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Map the models session/new advertised into runskein's SessionModel shape. */
function mapModels(models: AcpModelState | undefined): SessionModel[] | undefined {
  if (!models) return undefined;
  return models.availableModels.map((m) => {
    const model: SessionModel = { id: m.modelId, name: m.name };
    if (m.description != null) model.description = m.description;
    return model;
  });
}

function mapModes(modes: AcpModeState | undefined): SessionMode[] | undefined {
  if (!modes) return undefined;
  return modes.availableModes.map((m) => {
    const mode: SessionMode = { id: m.id, name: m.name };
    if (m.description != null) mode.description = m.description;
    return mode;
  });
}

/** Render a transcript as markdown, grouping consecutive chunks under one role heading. */
function renderMarkdown(events: TranscriptEvent[]): string {
  const lines: string[] = [];
  let currentRole: string | undefined;
  for (const e of events) {
    const u = e.update;
    if (
      (u.sessionUpdate === 'user_message_chunk' ||
        u.sessionUpdate === 'agent_message_chunk' ||
        u.sessionUpdate === 'agent_thought_chunk') &&
      u.content.type === 'text'
    ) {
      const role =
        u.sessionUpdate === 'user_message_chunk'
          ? 'User'
          : u.sessionUpdate === 'agent_message_chunk'
            ? 'Assistant'
            : 'Thinking';
      if (role !== currentRole) {
        lines.push(`\n## ${role}\n`);
        currentRole = role;
      }
      lines.push(u.content.text);
    } else if (u.sessionUpdate === 'tool_call') {
      currentRole = undefined;
      lines.push(`\n> tool: ${u.title ?? u.toolCallId} (${u.kind ?? 'other'})\n`);
    }
  }
  return lines.join('').trim() + '\n';
}

function mapConfigOptions(session: AcpNewSessionResult): ConfigOption[] {
  const raw = session.configOptions ?? [];
  const out: ConfigOption[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || typeof o['name'] !== 'string') continue;
    const type = o['type'];
    if (type !== 'select' && type !== 'boolean') continue;
    const option: ConfigOption = { id: o['id'], name: o['name'], type };
    if (typeof o['description'] === 'string') option.description = o['description'];
    if (typeof o['category'] === 'string') option.category = o['category'];
    if (Array.isArray(o['options'])) {
      option.options = o['options'] as NonNullable<ConfigOption['options']>;
    }
    if (typeof o['currentValue'] === 'string' || typeof o['currentValue'] === 'boolean') {
      option.currentValue = o['currentValue'];
    }
    out.push(option);
  }
  return out;
}
