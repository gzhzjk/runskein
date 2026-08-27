import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineOperationError, EngineStartError, NotInstalledError, UnauthenticatedError } from 'runskein';
import type { EngineAdapter, TranscriptStore } from '@runskein/core';
import { ProcessManager, readSessionMeta } from '@runskein/core/internal';

/**
 * The model each live suite pins per engine — the single source of truth for
 * both the conformance live runner and the CLI live suite
 * (`@runskein/conformance/live-support`), so the two cannot drift.
 *
 * Live runs are model-specific: an unpinned engine default is
 * account-dependent, which would make results incomparable across machines.
 *
 * Every engine takes its pin the same way — `config: { model }` at session
 * creation. claude-code used to be an exception with a launch-argument and
 * environment pin, both of which were measured to have no effect: its wrapper
 * rebuilds the environment for the process it spawns and ignores --model, so
 * pinned runs silently used the account default. It now goes through
 * session/set_model like everything else.
 */
export interface LiveModelPin {
  /** The exact model id both live suites force. */
  readonly model: string;
}

/** Per-engine live model pins, keyed by engine id. */
export const LIVE_MODEL_PINS: Readonly<Record<string, LiveModelPin>> = {
  opencode: { model: 'deepseek/deepseek-v4-flash' },
  kimi: { model: 'kimi-code/kimi-for-coding' },
  codex: { model: 'gpt-5.6-luna' },
  'claude-code': { model: 'sonnet' },
  // pi advertises five model ids, but advertising is not reachability: the
  // minimax ones end the turn with an error on this account. Pinned to the id
  // pi itself reports as current, which is the one demonstrably served.
  pi: { model: 'DeepSeek-V4-Flash-0731/DeepSeek-V4-Flash' },
};

/** The opt-in group for expensive live message-format cases. */
export const LIVE_E2E_EXTEND_GROUP = 'e2e-extend';

const LIVE_E2E_EXTEND_CASES = new Set(['OP-MSG-01', 'KI-MSG-01']);

/**
 * Decide whether a live case was explicitly selected by a case id or group.
 * @param caseId - the live case id.
 * @param liveInclude - comma-separated include values normalized to a set.
 * @returns true when the case should run instead of being waived.
 */
export function isLiveCaseOptedIn(caseId: string, liveInclude: ReadonlySet<string>): boolean {
  return (
    liveInclude.has('all') ||
    liveInclude.has(caseId) ||
    (LIVE_E2E_EXTEND_CASES.has(caseId) && liveInclude.has(LIVE_E2E_EXTEND_GROUP))
  );
}

/**
 * Return the opt-in label for a live case's waiver message.
 * @param caseId - the live case id.
 * @returns the group name for grouped cases, otherwise the case id.
 */
export function liveCaseOptInLabel(caseId: string): string {
  return LIVE_E2E_EXTEND_CASES.has(caseId) ? LIVE_E2E_EXTEND_GROUP : caseId;
}

/**
 * Race a promise against a timeout.
 * @param promise - the operation to await.
 * @param ms - the timeout in milliseconds.
 * @param label - used in the timeout error message.
 * @returns the promise's value.
 * @throws an Error naming the label after `ms` elapses.
 */
export async function withLiveTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Typed-error classes that can mark environmental live unavailability. */
const ENVIRONMENTAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'EngineOperationError',
  'EngineStartError',
  'UnauthenticatedError',
  'NotInstalledError',
]);

/** Message fragments that mark auth/network/quota unavailability.
 * A depleted account balance belongs here for the same reason a rate limit
 * does: it is the provider declining to serve, not the library misbehaving.
 * Observed live as opencode's `Internal error: Insufficient Balance`, which
 * hard-failed a whole run before this was recognised.
 * Deliberately narrow: bare `provider` waived real config bugs ("unknown
 * provider 'x'"), and an unqualified timeout is how a genuine prompt-path
 * regression surfaces, so timeouts only qualify on the startup operations
 * below. */
const ENVIRONMENTAL_MESSAGE =
  /auth|credential|network|provider (?:is )?unavailable|rate.?limit|usage.?limit|hit your limit|quota|insufficient (?:account )?(?:balance|credit|funds)|billing|ECONN|ENOTFOUND/i;

/** Timeout fragments — environmental only for session-setup operations, where
 * parallel four-engine startup load is the known (measured) cause. */
const TIMEOUT_MESSAGE = /timed? ?out/i;
const STARTUP_OPERATION = /^(?:session\/(?:new|load|resume|fork)|initialize|process\/)/i;

/** Cleanup operations never qualify for a waiver: those are real defects. */
const CLEANUP_OPERATION = /(?:close|quit|cleanup)/i;

/**
 * The waiver rule core shared by both live suites: an environmental failure
 * is one of the environmental error classes whose message shows an
 * auth/network/quota cause; cleanup failures never qualify.
 * @param className - the error class name (`error.name`).
 * @param message - the message text to classify (include causes when known).
 * @param operation - the failed operation, when the error carries one.
 * @returns true when the failure is environmental and may waive an assertion.
 */
export function isLiveEnvironmentalError(className: string, message: string, operation?: string): boolean {
  if (!ENVIRONMENTAL_ERROR_NAMES.has(className)) return false;
  if (operation !== undefined && CLEANUP_OPERATION.test(operation)) return false;
  if (ENVIRONMENTAL_MESSAGE.test(message)) return true;
  // Timeouts are environmental only during session setup (measured parallel-
  // startup contention); a prompt-path timeout is a potential real regression
  // and must FAIL, not waive. EngineStartError has no operation but is by
  // definition startup.
  if (TIMEOUT_MESSAGE.test(message)) {
    if (className === 'EngineStartError') return true;
    return operation !== undefined && STARTUP_OPERATION.test(operation);
  }
  return false;
}

/**
 * Decide whether a live failure is environmental — missing auth, network
 * trouble, a rate limit — and may therefore waive an assertion instead of
 * failing it. Typed-error adapter over isLiveEnvironmentalError.
 * @param error - the thrown value.
 * @returns true when the assertion should be waived rather than failed.
 */
export function isLiveEnvironmentUnavailable(error: unknown): boolean {
  if (
    !(error instanceof EngineOperationError) &&
    !(error instanceof EngineStartError) &&
    !(error instanceof UnauthenticatedError) &&
    !(error instanceof NotInstalledError)
  )
    return false;
  const cause = 'cause' in error ? error.cause : undefined;
  const message = `${error.message} ${cause instanceof Error ? cause.message : ''}`;
  return isLiveEnvironmentalError(
    error.name,
    message,
    error instanceof EngineOperationError ? error.operation : undefined,
  );
}

/**
 * Classify a CLI `[error] <ClassName>: <message> { …fields }` line with the
 * shared waiver rule. The formatter prints own enumerable fields, so an
 * EngineOperationError line carries its `operation: "…"` for the cleanup
 * exclusion. `unexpected:` lines (CLI bugs) and non-environmental classes
 * (e.g. ConfigError) never qualify.
 * @param line - the first `[error]` line of the CLI output, if any.
 * @returns true when the failure is environmental and may waive an assertion.
 */
export function isLiveEnvironmentErrorLine(line: string | undefined): boolean {
  if (line === undefined) return false;
  const match = /^\[error\] (\w+Error): (.*)$/.exec(line);
  if (match === null) return false;
  const operation = /\boperation: "([^"]+)"/.exec(match[2]!)?.[1];
  return isLiveEnvironmentalError(match[1]!, match[2]!, operation);
}

/**
 * The model family each engine must offer live. claude-code is absent on
 * purpose: it reports no live config options at all, only static hints, so
 * there is no model list to gate.
 */
const MODEL_FAMILIES: Record<string, RegExp> = {
  opencode: /minimax/i,
  kimi: /kimi/i,
  codex: /gpt-5\.6/,
};

/**
 * Check that a live model list contains the engine's expected family.
 * @param engine - the engine id.
 * @param values - the listed model ids.
 * @returns true when the family is present, or the engine is not gated.
 */
export function requiredModelFamilyPresent(engine: string, values: readonly string[]): boolean {
  const family = MODEL_FAMILIES[engine];
  if (family === undefined) return true;
  return values.some((value) => family.test(value));
}

/**
 * Return process-group leaders owned by one live runner for one engine.
 *
 * Live crash cases must not infer ownership from `ps` command text: worktree
 * paths can contain another engine id and engines can rewrite their title. The
 * ProcessManager records the exact leader pid at spawn, keyed by this owner.
 * @param entries - ownership records read from the ProcessManager registry.
 * @param engineId - engine whose process group will be fault-injected.
 * @param ownerPid - pid of the current live runner.
 * @returns unique leader pids owned by this runner for the requested engine.
 */
export function ownedLiveEnginePids(
  entries: readonly { enginePid: number; engineId: string; ownerPid: number }[],
  engineId: string,
  ownerPid: number,
): number[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.engineId === engineId && entry.ownerPid === ownerPid)
        .map((entry) => entry.enginePid),
    ),
  ];
}

// ── engine-side session cleanup ─────────────────────────────────────────────

/**
 * Outcome of one engine's post-suite session cleanup. Cleanup is evidence
 * hygiene, never a gate: a failure here must not fail a live run.
 */
export interface EngineSessionCleanup {
  engine: string;
  /** False when the engine does not advertise `session/delete` (measured:
   * opencode and claude-code) — nothing was attempted. */
  supported: boolean;
  attempted: number;
  deleted: number;
  /** Native ids whose delete failed, with the error's first line. */
  failed: string[];
}

/**
 * Collect every engine-native session id a suite's transcript store knows
 * about. The runskein-side sessionMetaUpdate events carry `nativeSessionId`
 * (creation, resume, fork), so the store the suite already writes is a
 * complete inventory of the engine-side sessions it caused.
 * @param store - the suite's transcript store.
 * @param engineId - only sessions of this engine.
 * @returns unique native session ids.
 */
export async function collectNativeSessionIds(store: TranscriptStore, engineId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const meta of await store.sessions({ engineId })) {
    for await (const event of store.read(meta.sessionId)) {
      const runskeinMeta = readSessionMeta(event.update);
      if (runskeinMeta?.nativeSessionId !== undefined) ids.add(runskeinMeta.nativeSessionId);
    }
  }
  return [...ids];
}

/**
 * Read engine-native session ids through ACP `session/list`.
 *
 * The runskein store remains authoritative for its own session inventory; this
 * helper is intentionally a live-only cross-check for negotiated discard.
 * @param adapter - the engine adapter to launch.
 * @returns whether listing is advertised and the ids returned by every page.
 * @throws when the engine advertises listing but rejects a list request.
 */
export async function listEngineSessionIds(
  adapter: EngineAdapter,
): Promise<{ supported: boolean; ids: string[] }> {
  const manager = new ProcessManager({ handlers: {} });
  try {
    try {
      const acquired = await manager.acquire(adapter, {
        cwd: mkdtempSync(join(tmpdir(), 'runskein-list-')),
      });
      try {
        if (acquired.connection.capabilities.session['list'] !== true) {
          return { supported: false, ids: [] };
        }

        const ids = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw new Error(`session/list repeated cursor '${cursor}'`);
            cursors.add(cursor);
          }
          const result = (await withLiveTimeout(
            acquired.connection.rawRequest('session/list', cursor === undefined ? {} : { cursor }),
            10_000,
            'session/list',
          )) as unknown;
          const body =
            typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
          const page = Array.isArray(result)
            ? result
            : Array.isArray(body?.['sessions'])
              ? body['sessions']
              : undefined;
          if (page === undefined) throw new Error('session/list returned no sessions array');
          for (const entry of page) {
            if (typeof entry === 'string') {
              ids.add(entry);
            } else if (typeof entry === 'object' && entry !== null) {
              const value = entry as Record<string, unknown>;
              const id = value['sessionId'] ?? value['id'];
              if (typeof id === 'string') ids.add(id);
            }
          }
          const next = body?.['nextCursor'] ?? body?.['next_cursor'];
          cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
        } while (cursor !== undefined);

        return { supported: true, ids: [...ids] };
      } finally {
        acquired.release();
      }
    } catch (error) {
      if (
        error instanceof EngineOperationError ||
        error instanceof EngineStartError ||
        error instanceof UnauthenticatedError ||
        error instanceof NotInstalledError
      ) {
        throw error;
      }
      throw new EngineOperationError({ engineId: adapter.id, operation: 'session/list', cause: error });
    }
  } finally {
    await manager.quit();
  }
}

/**
 * Delete the given engine-native sessions via ACP `session/delete`, spawning
 * a short-lived engine process of its own (the suite's hub has already quit
 * by cleanup time). Only sessions the suite itself created may be passed —
 * this deletes real engine-side history.
 *
 * Measured (2026-08-08, docs/todo.md item 10): kimi and codex really delete
 * (codex including the on-disk jsonl); a codex session that never had a
 * prompt returns `Internal error`, which is harmless (nothing was persisted)
 * and lands in `failed`. opencode and claude-code do not advertise the verb
 * and are skipped wholesale.
 * @param adapter - the engine adapter to launch.
 * @param nativeIds - the native session ids to delete.
 * @returns the per-engine cleanup outcome; never throws for per-id failures.
 */
export async function deleteEngineSessions(
  adapter: EngineAdapter,
  nativeIds: string[],
): Promise<EngineSessionCleanup> {
  const outcome: EngineSessionCleanup = {
    engine: adapter.id,
    supported: true,
    attempted: 0,
    deleted: 0,
    failed: [],
  };
  if (nativeIds.length === 0) return outcome;
  const manager = new ProcessManager({ handlers: {} });
  try {
    const acquired = await manager.acquire(adapter, {
      cwd: mkdtempSync(join(tmpdir(), 'runskein-cleanup-')),
    });
    try {
      if (acquired.connection.capabilities.session['delete'] !== true) {
        outcome.supported = false;
        return outcome;
      }
      for (const sessionId of nativeIds) {
        outcome.attempted++;
        try {
          await withLiveTimeout(
            acquired.connection.rawRequest('session/delete', { sessionId }),
            10_000,
            `session/delete ${sessionId}`,
          );
          outcome.deleted++;
        } catch (e) {
          outcome.failed.push(`${sessionId}: ${String(e).split('\n')[0] ?? ''}`);
        }
      }
      return outcome;
    } finally {
      acquired.release();
    }
  } finally {
    await manager.quit();
  }
}
