/**
 * ProcessManager — EngineHandle lifecycle: at most one child
 * process per engine id, reference-counted sharing, idle reaping, crash
 * detection with exponential-backoff restart, and the graceful quit chain.
 */
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { AcpConnection } from '../acp/connection.js';
import type { AcpClientHandlers } from '../acp/clientMethods.js';
import type { WireObserver } from '../acp/wireTrace.js';
import { EngineOperationError, EngineStartError } from '../errors.js';
import type { EngineAdapter, EngineCrashInfo, Health, Unsubscribe } from '../types.js';
import type { IdleClock } from '../session/idleClock.js';
import { realIdleClock } from '../session/idleClock.js';
import { HealthMachine } from './health.js';
import {
  fileOwnershipRegistry,
  sweepOrphans,
  type OrphanSweepResult,
  type OwnershipRegistry,
} from './ownership.js';
import { spawnEngine, stopTree, stopTreeByPid } from './spawn.js';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_BASE_MS = 500;
const STABILITY_RESET_MS = 30_000;

type Phase = 'running' | 'quitting' | 'reaping';

/**
 * Classify a startup failure into the EngineStartError stage.
 * @param cause - The error observed during startup.
 * @returns 'timeout' for timeouts, 'spawn' for spawn/early-exit failures, else 'initialize'.
 */
function startStage(cause: Error): 'spawn' | 'initialize' | 'timeout' {
  if (/^timeout after /.test(cause.message)) return 'timeout';
  if (/^(spawn failed|process exited during startup)/.test(cause.message)) return 'spawn';
  return 'initialize';
}

interface EngineHandle {
  adapter: EngineAdapter;
  health: HealthMachine;
  refcount: number;
  phase: Phase;
  /** Incremented per spawn; stale exit handlers compare and bail. */
  generation: number;
  child: ChildProcess | undefined;
  connection: AcpConnection | undefined;
  stderrTail: (() => string) | undefined;
  /** In-flight (or completed) start; concurrent acquires share it. */
  startPromise: Promise<AcpConnection> | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  stabilityTimer: NodeJS.Timeout | undefined;
  /** In-flight idle reap; acquire() must wait for it before restarting. */
  reapPromise: Promise<void> | undefined;
  /** In-flight quit; acquire() must wait for it so it never reuses the dying
   * process's still-resolved startPromise. */
  quitPromise: Promise<void> | undefined;
  restartAttempts: number;
  /** Working directory used by the current process; reused for crash restart. */
  launchCwd: string | undefined;
}

export interface AcquiredEngine {
  engineId: string;
  connection: AcpConnection;
  release: () => void;
}

export interface ProcessManagerOptions {
  idleTimeoutMs?: number;
  /** Applied to connections this manager creates; a factory gets the engine id. */
  handlers?: AcpClientHandlers | ((engineId: string) => AcpClientHandlers);
  /** Backoff hook for tests; defaults to real setTimeout sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Internal wire-trace seam for connections this manager creates.
   *
   * Always a factory taking the engine id, never a bare observer: an observer
   * and a factory are both one-argument functions, so the two could not be
   * told apart at runtime. Return undefined to leave an engine untraced; a
   * caller wanting one observer for everything returns the same one.
   *
   * Called once per CONNECTION, not once per engine — so a crash restart calls
   * it again for the same engine id. A factory that allocates fresh state each
   * time therefore discards the previous connection's frames, which is exactly
   * the traffic a crash investigation wants; keep the collector outside the
   * factory unless per-connection scoping is the intent.
   */
  wireObserver?: (engineId: string) => WireObserver | undefined;
  /**
   * Where engine ownership is recorded so a later host can tell an abandoned
   * process from a live sibling's. Defaults to the shared user-state file.
   */
  ownership?: OwnershipRegistry;
  /** Gap between orphan sweeps while the manager is live. Default 300 000 ms. */
  sweepIntervalMs?: number;
  /**
   * Timer source for the periodic sweep. Injected by tests so "ran once per
   * interval" and "ticks coalesce" can be asserted without waiting minutes.
   */
  sweepClock?: IdleClock;
  /** Per-run sweep report; the only way to observe a sweep that found nothing. */
  onSweep?: (result: OrphanSweepResult) => void;
}

/** Gap between orphan sweeps while a manager is live. */
const DEFAULT_SWEEP_INTERVAL_MS = 300_000;

type ManagerEvent =
  | 'engine:crash'
  | 'engine:restarted'
  | 'engine:unauthenticated'
  // Raised by the Hub rather than here, but routed through the same registry:
  // one dispatch path keeps `hub.on()` a single mechanism instead of two that
  // differ by which events happen to originate where.
  | 'engine:cleanup-failed';

export class ProcessManager {
  private readonly handles = new Map<string, EngineHandle>();
  private readonly idleTimeoutMs: number;
  private readonly handlers: ProcessManagerOptions['handlers'];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly wireObserver: ProcessManagerOptions['wireObserver'];
  private readonly listeners = new Map<ManagerEvent, Set<(payload: never) => void>>();
  private readonly ownership: OwnershipRegistry;
  private readonly sweepIntervalMs: number;
  private readonly sweepClock: IdleClock;
  private readonly onSweep: ProcessManagerOptions['onSweep'];
  /** Shared by concurrent callers so overlapping ticks become one run. */
  private sweepInFlight: Promise<OrphanSweepResult> | undefined;
  private cancelSweepTimer: (() => void) | undefined;
  private sweepStarted = false;
  private sweepStopped = false;

  /**
   * Create a manager with optional idle timeout, client-method handlers, a
   * testable sleep hook for backoff, and an internal wire-trace factory.
   * @param options - idleTimeoutMs, handlers (object or per-engine factory), sleep backoff hook, and per-engine wireObserver factory.
   */
  constructor(options: ProcessManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.handlers = options.handlers;
    this.sleep = options.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms).unref?.()));
    this.wireObserver = options.wireObserver;
    this.ownership = options.ownership ?? fileOwnershipRegistry();
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepClock = options.sweepClock ?? realIdleClock;
    this.onSweep = options.onSweep;
  }

  // ── orphan sweep ─────────────────────────────────────────────────────────

  /**
   * Run the first sweep and start the periodic one.
   *
   * Deliberately tied to the first acquisition rather than to construction: a
   * Hub that is only inspected (engines(), describe()) never adopts anyone
   * else's orphans, and a sweep that killed processes for a host that never
   * ran an engine would be surprising.
   */
  private async ensureSweeping(): Promise<void> {
    if (this.sweepStarted || this.sweepStopped) return;
    this.sweepStarted = true;
    await this.runSweep();
    this.scheduleSweep();
  }

  /** Arm the next periodic sweep; the timer never keeps the process alive. */
  private scheduleSweep(): void {
    if (this.sweepStopped) return;
    this.cancelSweepTimer = this.sweepClock.schedule(this.sweepIntervalMs, () => {
      this.cancelSweepTimer = undefined;
      void this.runSweep().finally(() => this.scheduleSweep());
    });
  }

  /**
   * Sweep once, coalescing concurrent callers onto a single run.
   * @returns what the run scanned, reaped, and pruned.
   */
  private runSweep(): Promise<OrphanSweepResult> {
    this.sweepInFlight ??= sweepOrphans(this.ownership, (pid) => stopTreeByPid(pid))
      .then((result) => {
        this.onSweep?.(result);
        return result;
      })
      .catch((error: unknown) => {
        // A sweep is best-effort housekeeping: a registry it cannot read must
        // not stop the engine the caller actually asked for.
        console.error(`[runskein] orphan sweep failed: ${String(error)}`);
        const empty: OrphanSweepResult = { scanned: 0, reaped: 0, prunedStaleEntries: 0 };
        this.onSweep?.(empty);
        return empty;
      })
      .finally(() => {
        this.sweepInFlight = undefined;
      });
    return this.sweepInFlight;
  }

  /**
   * Record who owns a freshly spawned engine, and forget it when it exits.
   *
   * The exit listener is separate from the crash handling below on purpose: it
   * must fire for every way a process can end — reap, quit, or crash — whereas
   * that one deliberately ignores exits it does not own.
   * @param engineId - the engine being launched.
   * @param child - the spawned process group leader.
   * @param argv0 - the launch command, checked against a live pid before any reap.
   */
  private trackOwnership(engineId: string, child: ChildProcess, argv0: string): void {
    const enginePid = child.pid;
    if (enginePid === undefined) return;
    const failed = (error: unknown): void => {
      // Bookkeeping must never break the engine the caller asked for. A record
      // that fails to land can cost a leaked process later; refusing to start
      // costs the caller their session now.
      console.error(`[runskein] engine ownership registry write failed: ${String(error)}`);
    };
    void this.ownership
      .add({ enginePid, engineId, ownerPid: process.pid, argv0, startedAt: Date.now() })
      .catch(failed);
    child.once('exit', () => {
      void this.ownership.remove(enginePid).catch(failed);
    });
  }

  /** Stop sweeping; called when the whole manager quits. */
  private async stopSweeping(): Promise<void> {
    this.sweepStopped = true;
    this.cancelSweepTimer?.();
    this.cancelSweepTimer = undefined;
    // A sweep already in flight has to finish before quit resolves. Cancelling
    // the timer only stops the next one; without this, a caller that awaited
    // quit and then tore down its state could still be handed a sweep result
    // from the run that was already going.
    await this.sweepInFlight?.catch(() => undefined);
  }

  // ── events ───────────────────────────────────────────────────────────────

  on(event: 'engine:crash', cb: (info: EngineCrashInfo) => void): Unsubscribe;
  on(event: 'engine:restarted', cb: (info: { engineId: string }) => void): Unsubscribe;
  /** Emitted by the hub when a session spawn hits missing credentials. */
  on(event: 'engine:unauthenticated', cb: (info: { engineId: string }) => void): Unsubscribe;
  /**
   * Subscribe to a manager event; the returned function unsubscribes.
   * @param event - One of engine:crash, engine:restarted, or engine:unauthenticated.
   * @param cb - Callback invoked with the event payload.
   * @returns A function that removes the subscription.
   */
  on(event: ManagerEvent, cb: (payload: never) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /**
   * Dispatch an event to all subscribers, swallowing listener exceptions so one
   * broken listener cannot break the rest.
   * @internal Also used by Hub for engine:unauthenticated (session path).
   * @param event - The event name to emit.
   * @param payload - Data passed to each listener.
   */
  emit(event: ManagerEvent, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        (cb as (p: unknown) => void)(payload);
      } catch (e) {
        console.error(`[runskein] ${event} listener threw: ${(e as Error).message}`);
      }
    }
  }

  // ── public surface ───────────────────────────────────────────────────────

  /**
   * Process-level health; 'stopped' when the engine was never started.
   * @param engineId - Id of the engine to inspect.
   * @returns The current health, or 'stopped' for unknown engines.
   */
  healthOf(engineId: string): Extract<Health, 'stopped' | 'starting' | 'ready' | 'degraded' | 'dead'> {
    return this.handles.get(engineId)?.health.state ?? 'stopped';
  }

  /**
   * Ensure the engine process is running and initialized, and take a
   * reference. Callers MUST call release() exactly once when done.
   * @param adapter - The adapter describing how to launch the engine.
   * @param opts - Optional cwd to launch the process in (defaults to process.cwd()).
   * @returns An acquired handle with its connection and a release() function.
   * @throws `EngineStartError` when the process fails to spawn or initialize.
   * @throws `Error` when the engine was restarted while startup was in flight.
   * @throws `EngineOperationError` when an in-flight idle reap failed before the acquire.
   */
  async acquire(adapter: EngineAdapter, opts?: { cwd?: string }): Promise<AcquiredEngine> {
    let handle = this.handles.get(adapter.id);
    if (!handle) {
      handle = {
        adapter,
        health: new HealthMachine(),
        refcount: 0,
        phase: 'running',
        generation: 0,
        child: undefined,
        connection: undefined,
        stderrTail: undefined,
        startPromise: undefined,
        idleTimer: undefined,
        stabilityTimer: undefined,
        reapPromise: undefined,
        quitPromise: undefined,
        restartAttempts: 0,
        launchCwd: undefined,
      };
      this.handles.set(adapter.id, handle);
    }
    // Reap whatever a previously-killed host left behind before adding to it.
    await this.ensureSweeping();
    handle.adapter = adapter; // explicit adapters may be re-registered on rescan
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = undefined;
    }
    handle.refcount++;
    try {
      // A reap or quit may already be killing the process; wait it out so the
      // start below spawns fresh instead of reusing the dying connection —
      // quitHandle clears startPromise only after its multi-second stop chain,
      // so acquiring mid-quit would otherwise hand back a dying process.
      if (handle.reapPromise) await handle.reapPromise;
      if (handle.quitPromise) await handle.quitPromise.catch(() => undefined);
      const connection = await this.ensureStarted(handle, opts?.cwd ?? process.cwd());
      let released = false;
      return {
        engineId: adapter.id,
        connection,
        release: () => {
          if (released) return;
          released = true;
          this.release(handle);
        },
      };
    } catch (e) {
      this.release(handle);
      throw e;
    }
  }

  /**
   * Graceful quit chain; no arg = all engines. Quit engines become 'dead'.
   * @param engineId - Optional id; when omitted, every engine is quit.
   * @param opts - Optional timeoutMs per engine (default 3s).
   * @returns Resolves when all targeted engines have quit.
   * @throws `EngineOperationError` when a process tree survives the SIGKILL stage.
   */
  async quit(engineId?: string, opts?: { timeoutMs?: number }): Promise<void> {
    // A per-engine quit leaves the manager live and still responsible for
    // sweeping; quitting everything is what ends that responsibility.
    if (engineId === undefined) await this.stopSweeping();
    const targets = engineId
      ? [this.handles.get(engineId)].filter((h): h is EngineHandle => !!h)
      : [...this.handles.values()];
    await Promise.all(
      targets.map((h) => {
        // Auth recovery and an explicit hub.quit() can target the same handle
        // in one tick. Reusing the stop chain prevents two SIGTERM/SIGKILL
        // sequences from racing over the same child and connection fields.
        if (h.quitPromise) return h.quitPromise;
        const p = this.quitHandle(h, opts?.timeoutMs ?? 3_000).finally(() => {
          if (h.quitPromise === p) h.quitPromise = undefined;
        });
        h.quitPromise = p;
        return p;
      }),
    );
  }

  /**
   * Drop all handles (rescan support); live processes are quit first.
   * @returns Resolves once every engine has quit and all handles are cleared.
   * @throws `EngineOperationError` when any process tree survives the quit chain.
   */
  async reset(): Promise<void> {
    await this.quit();
    this.handles.clear();
  }

  // ── lifecycle internals ──────────────────────────────────────────────────

  /**
   * Return the in-flight or completed start for a handle, starting it on first
   * call and sharing that promise across concurrent acquirers.
   * @param handle - The engine handle to start.
   * @param cwd - Working directory for the launch.
   * @returns A promise resolving to the started connection.
   * @throws Rejects with the underlying start() failure (`EngineStartError`, etc.).
   */
  private ensureStarted(handle: EngineHandle, cwd: string): Promise<AcpConnection> {
    if (!handle.startPromise) {
      const p = this.start(handle, cwd);
      handle.startPromise = p;
      p.catch(() => {
        if (handle.startPromise === p) handle.startPromise = undefined;
      });
    }
    return handle.startPromise;
  }

  /**
   * Spawn and initialize the engine process, wiring the child into an ACP
   * connection. A crash-restart stays 'degraded' until it proves 'ready'.
   * @param handle - The engine handle to launch.
   * @param cwd - Working directory for the launch.
   * @returns The initialized ACP connection.
   * @throws `EngineStartError` when spawn/initialize fails (with stage and cause).
   * @throws `Error` when the engine was restarted during this startup.
   */
  private async start(handle: EngineHandle, cwd: string): Promise<AcpConnection> {
    if (handle.health.state !== 'degraded') handle.health.to('starting');
    handle.phase = 'running';
    handle.generation++;
    const generation = handle.generation;
    const launchCwd = resolve(cwd);
    const { child, stderrTail, argv0 } = spawnEngine(handle.adapter, { cwd: launchCwd });
    handle.child = child;
    handle.stderrTail = stderrTail;
    this.trackOwnership(handle.adapter.id, child, argv0);

    const handlers = typeof this.handlers === 'function' ? this.handlers(handle.adapter.id) : this.handlers;
    const onWireFrame = this.wireObserver?.(handle.adapter.id);
    const connection = new AcpConnection({
      stdin: child.stdin!,
      stdout: child.stdout!,
      ...(handlers ? { handlers } : {}),
      ...(onWireFrame ? { onWireFrame } : {}),
    });
    handle.connection = connection;

    child.once('exit', (code, signal) => {
      this.onExit(handle, generation, code, signal);
    });

    const startTimeoutMs = handle.adapter.launch.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const spawnFailed = new Promise<never>((_, rej) => {
      child.once('error', (e) => rej(new Error(`spawn failed: ${e.message}`)));
      child.once('exit', (code) =>
        rej(new Error(`process exited during startup (code ${code}): ${stderrTail().slice(-500)}`)),
      );
    });
    // The exit listener outlives a successful start; without a handler the
    // eventual normal exit (reap/quit) becomes an unhandled rejection.
    spawnFailed.catch(() => {});

    try {
      await Promise.race([spawnFailed, connection.initialize({ timeoutMs: startTimeoutMs })]);
    } catch (e) {
      // Startup failure: kill whatever half-started and surface the cause.
      // onExit ignores exits while 'starting'/'degraded', so this path owns
      // the cleanup. Prefer the exit diagnostics (code + stderr) over the
      // SDK's generic "connection closed" when the process died — stream EOF
      // usually races ahead of the child 'exit' event.
      let cause = await Promise.race([
        spawnFailed.catch((exitError: Error) => exitError),
        this.sleep(150).then(() => e as Error),
      ]);
      const stage = startStage(cause);
      connection.close(cause);
      if (!(await stopTree(child))) {
        cause = new AggregateError(
          [cause, new Error('process tree survived startup cleanup')],
          'engine startup and cleanup both failed',
        );
      }
      if (handle.generation === generation && handle.health.live) {
        handle.health.to('dead');
      }
      throw new EngineStartError({
        engineId: handle.adapter.id,
        stage,
        cause,
      });
    }

    if (handle.generation !== generation) {
      throw new Error(`engine '${handle.adapter.id}' was restarted during startup`);
    }
    handle.health.to('ready');
    handle.launchCwd = launchCwd;
    // Restart budget resets only after the process proves stable.
    if (handle.stabilityTimer) clearTimeout(handle.stabilityTimer);
    handle.stabilityTimer = setTimeout(() => {
      handle.restartAttempts = 0;
    }, STABILITY_RESET_MS);
    handle.stabilityTimer.unref?.();
    return connection;
  }

  /**
   * Handle a child exit: ignore stale, quit/reap-owned, and pre-'ready' exits,
   * and route only live 'ready' crashes into the restart loop.
   * @param handle - The owning engine handle.
   * @param generation - The spawn generation the exiting child belongs to.
   * @param code - The exit code, or null when signalled.
   * @param signal - The terminating signal, or null.
   */
  private onExit(
    handle: EngineHandle,
    generation: number,
    code: number | null,
    signal: string | null,
  ): void {
    if (handle.generation !== generation) return; // stale: already respawned
    if (handle.phase !== 'running') return; // quit/reap paths own this exit
    if (handle.health.state !== 'ready') return; // start()/restartLoop own non-ready exits
    const detail = `exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}${
      handle.stderrTail ? `: ${handle.stderrTail().slice(-300)}` : ''
    }`;
    handle.connection?.close(new Error(`engine process exited (${detail})`));
    handle.startPromise = undefined;

    if (handle.refcount === 0) {
      // Idle crash: no user to notify, nothing to restore — treat like a
      // reap so the next acquire path is identical to first use.
      if (handle.health.live) handle.health.to('stopped');
      handle.child = undefined;
      handle.connection = undefined;
      return;
    }

    handle.health.to('degraded');
    this.emit('engine:crash', {
      engineId: handle.adapter.id,
      detail,
      restarting: true,
    } satisfies EngineCrashInfo);
    const p = this.restartLoop(handle);
    handle.startPromise = p;
    p.catch(() => {
      // Surfaced to awaiting acquirers; also clear so the next acquire retries.
      if (handle.startPromise === p) handle.startPromise = undefined;
    });
  }

  /**
   * Restart a crashed engine with exponential backoff, up to the restart
   * budget; the backoff timer unref'd sleeps via the manager's sleep hook.
   * @param handle - The engine handle to restart.
   * @returns The connection of the successfully restarted engine.
   * @throws `EngineStartError` when the restart budget is exhausted.
   */
  private async restartLoop(handle: EngineHandle): Promise<AcpConnection> {
    let lastError: unknown;
    while (handle.restartAttempts < MAX_RESTART_ATTEMPTS) {
      const backoff = RESTART_BACKOFF_BASE_MS * 2 ** handle.restartAttempts;
      handle.restartAttempts++;
      await this.sleep(backoff);
      if (handle.phase !== 'running') break; // quit won the race
      try {
        const connection = await this.start(handle, handle.launchCwd ?? process.cwd());
        this.emit('engine:restarted', { engineId: handle.adapter.id });
        // release() skips arming the idle timer while 'degraded'; if the last
        // reference was dropped during the restart, arm it now so the
        // recovered process does not linger unreferenced forever.
        if (handle.refcount === 0) {
          handle.refcount = 1; // balance the release() bookkeeping below
          this.release(handle);
        }
        return connection;
      } catch (e) {
        // start() marked the handle dead; the next attempt re-enters via
        // dead → starting. Keep the last cause for the exhaustion error.
        lastError = e;
      }
    }
    if (handle.health.live) handle.health.to('dead');
    throw (
      lastError ??
      new EngineStartError({
        engineId: handle.adapter.id,
        stage: 'spawn',
        cause: new Error('restart budget exhausted'),
      })
    );
  }

  /**
   * Drop a reference; at zero and live, schedule the idle reap after the idle
   * timeout, reaping on the unref'd timer.
   * @param handle - The engine handle to release.
   */
  private release(handle: EngineHandle): void {
    handle.refcount = Math.max(0, handle.refcount - 1);
    if (handle.refcount > 0) return;
    if (!handle.health.live) return;
    // A crash-restart is in flight ('degraded'): arming the idle timer now
    // could reap the restarting child mid-spawn and hit an illegal
    // degraded → stopped health transition. The restart's outcome settles the
    // handle: 'ready' (a later release arms the timer) or 'dead'.
    if (handle.health.state === 'degraded') return;
    if (handle.idleTimer) clearTimeout(handle.idleTimer);
    handle.idleTimer = setTimeout(() => {
      const p = this.reap(handle)
        .catch((error: unknown) => {
          console.error(`[runskein] idle reap failed for '${handle.adapter.id}': ${String(error)}`);
          if (handle.health.live) handle.health.to('dead');
        })
        .finally(() => {
          if (handle.reapPromise === p) handle.reapPromise = undefined;
        });
      handle.reapPromise = p;
    }, this.idleTimeoutMs);
    handle.idleTimer.unref?.();
  }

  /**
   * Idle reap: graceful, ready → stopped, never an engine:crash.
   * @param handle - The engine handle to reap.
   * @returns Resolves once the process tree has stopped.
   * @throws `EngineOperationError` when the process tree survives SIGKILL.
   */
  private async reap(handle: EngineHandle): Promise<void> {
    if (handle.refcount > 0 || !handle.health.live || !handle.child) return;
    handle.phase = 'reaping';
    const child = handle.child;
    if (!(await stopTree(child))) {
      throw new EngineOperationError({
        engineId: handle.adapter.id,
        operation: 'process/reap',
        cause: new Error('process tree survived SIGKILL'),
      });
    }
    handle.connection?.close();
    handle.connection = undefined;
    handle.child = undefined;
    handle.startPromise = undefined;
    // A concurrent quit() may have won and marked the handle dead already.
    if (handle.health.live) handle.health.to('stopped');
    if (handle.phase === 'reaping') handle.phase = 'running';
  }

  /**
   * Quit one engine: clear timers and run the graceful stop chain, then mark
   * it dead. Never-started or already-stopped handles are a no-op.
   * @param handle - The engine handle to quit.
   * @param timeoutMs - Grace period before the SIGKILL stage.
   * @returns Resolves once the engine has quit.
   * @throws `EngineOperationError` when the process tree survives SIGKILL.
   */
  private async quitHandle(handle: EngineHandle, timeoutMs: number): Promise<void> {
    if (handle.idleTimer) clearTimeout(handle.idleTimer);
    if (handle.stabilityTimer) clearTimeout(handle.stabilityTimer);
    if (!handle.health.live || !handle.child) {
      // Never-started or already stopped/dead: explicit quit is a no-op.
      return;
    }
    handle.phase = 'quitting';
    const child = handle.child;
    if (!(await stopTree(child, timeoutMs))) {
      throw new EngineOperationError({
        engineId: handle.adapter.id,
        operation: 'process/quit',
        cause: new Error('process tree survived SIGKILL'),
      });
    }
    handle.connection?.close();
    handle.connection = undefined;
    handle.child = undefined;
    handle.startPromise = undefined;
    handle.health.to('dead');
  }
}
