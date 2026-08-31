import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EngineOperationError, EngineStartError, NotInstalledError, UnauthenticatedError } from 'runskein';
import type { EngineAdapter, TranscriptStore } from '@runskein/core';
import type { EngineDescriptor } from 'runskein';
import type { WireFrame } from '@runskein/core/internal';
import { ProcessManager, readSessionMeta } from '@runskein/core/internal';

/**
 * Per-engine live configuration, loaded from the adapter package's own
 * `live.config.json`.
 *
 * Live runs are model-specific: an unpinned engine default is
 * account-dependent, which would make results incomparable across machines, so
 * every live session creation forces the adapter's pinned config. Which model
 * an engine should run is a property of that engine's adapter — that is why
 * the pin lives in the adapter package rather than in a table here.
 *
 * Every engine takes its pin the same way — `config: { model, … }` at session
 * creation. claude-code used to be an exception with a launch-argument and
 * environment pin, both of which were measured to have no effect: its wrapper
 * rebuilds the environment for the process it spawns and ignores --model, so
 * pinned runs silently used the account default. It now goes through
 * session/set_model like everything else.
 */
export interface LiveEngineConfig {
  /** Forced session config, applied as `SessionOpts.config` at creation. */
  readonly config?: Record<string, string | boolean>;
  /** Extra launch environment for live runs of this engine. */
  readonly env?: Record<string, string>;
}

/**
 * Return the environment variable that overrides an engine's pinned model.
 * @param engineId - the engine id (dashes become underscores).
 * @returns the variable name, e.g. `RUNSKEIN_LIVE_MODEL_CLAUDE_CODE`.
 */
export function liveModelEnvVar(engineId: string): string {
  return `RUNSKEIN_LIVE_MODEL_${engineId.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * Resolve the live config file path inside an engine's adapter package.
 *
 * Adapter `exports` do not expose `./package.json`, so the package entry is
 * resolved and the file sits beside it. The resolution goes through
 * `createRequire` rather than `import.meta.resolve` because the vitest/vite
 * transform shims the latter and the shim does not resolve bare specifiers
 * against node_modules.
 * @param engineId - the engine id.
 * @returns the absolute path of the adapter's `live.config.json`.
 * @throws `Error` when no adapter package resolves for the engine id.
 */
export function liveConfigPath(engineId: string): string {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(`@runskein/adapter-${engineId}`);
  } catch {
    throw new Error(`live config: no adapter package resolves for engine '${engineId}'`);
  }
  return join(dirname(entry), 'live.config.json');
}

/**
 * Load an engine's live configuration from its adapter package.
 *
 * The `RUNSKEIN_LIVE_MODEL_<ID>` environment variable (see liveModelEnvVar),
 * when set, replaces the file's model pin. It is read at call time so a test
 * process can set it per case.
 * @param engineId - the engine id.
 * @returns the validated configuration.
 * @throws `Error` naming the file when it is missing, unparsable, or carries
 *   values of the wrong shape. Whether the engine accepts a key or value is
 *   core's question at session creation, against the engine's advertised
 *   surface — not this function's.
 */
export function liveConfigFor(engineId: string): LiveEngineConfig {
  const file = liveConfigPath(engineId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `live config: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`live config: ${file} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const result: {
    config?: Record<string, string | boolean>;
    env?: Record<string, string>;
  } = {};
  if (obj['config'] !== undefined) {
    const config: unknown = obj['config'];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`live config: ${file} 'config' must be an object of string|boolean values`);
    }
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw new Error(`live config: ${file} config.${key} must be a string or boolean`);
      }
    }
    result.config = config as Record<string, string | boolean>;
    // The file must be valid on its own — a malformed file throws even when an
    // override would have replaced the bad value.
    const fileModel = result.config['model'];
    if (fileModel !== undefined && (typeof fileModel !== 'string' || fileModel.trim() === '')) {
      throw new Error(`live config: ${file} config.model must be a non-empty string`);
    }
  }
  if (obj['env'] !== undefined) {
    const env: unknown = obj['env'];
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new Error(`live config: ${file} 'env' must be an object of string values`);
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new Error(`live config: ${file} env.${key} must be a string`);
      }
    }
    result.env = env as Record<string, string>;
  }
  const override = process.env[liveModelEnvVar(engineId)];
  if (override !== undefined && override !== '') {
    if (override.trim() === '') {
      throw new Error(`live config: ${liveModelEnvVar(engineId)} override must be a non-empty model id`);
    }
    result.config = { ...result.config, model: override };
  }
  return result;
}

/**
 * Build the skip/waive reason for a live case whose pinned config the engine
 * rejected. It names every pinned key and value, the file to edit and the
 * override variable, because a silent skip would re-create the drift the pin
 * exists to prevent — and naming only `model` would misidentify the value when
 * the rejected key is another one (reasoning, mode, …).
 * @param engineId - the engine id.
 * @param config - the configuration the engine refused.
 * @returns the human-readable reason.
 * @throws `Error` when no adapter package resolves for the engine id (via
 *   liveConfigPath).
 */
export function livePinRejectionReason(engineId: string, config: LiveEngineConfig): string {
  const pinned = Object.entries(config.config ?? {}).map(([key, value]) => `${key} '${String(value)}'`);
  return (
    `engine '${engineId}' rejected the pinned live config` +
    (pinned.length > 0 ? ` (${pinned.join(', ')})` : '') +
    ` from ${liveConfigPath(engineId)} — edit that file or set ${liveModelEnvVar(engineId)}`
  );
}

/**
 * An engine's refusal of its own pinned live config at session creation.
 *
 * Distinct from a bare ConfigError on purpose: only the pin's rejection is an
 * environment mismatch (this machine cannot serve the pinned value), while a
 * ConfigError against config a case constructed itself — CF-10's creation
 * key — is a real contract regression and must fail. The shared waiver rule
 * recognises this class and never a bare ConfigError.
 */
export class LivePinRejectedError extends Error {
  /** The engine that refused the pin. */
  readonly engineId: string;

  /**
   * @param engineId - the engine id.
   * @param config - the pinned configuration the engine refused.
   * @param cause - the ConfigError the engine raised; its message is appended
   *   so the engine's own explanation (the rejected key, the valid values)
   *   survives into the case log.
   * @throws `Error` when no adapter package resolves for the engine id (via
   *   livePinRejectionReason).
   */
  constructor(engineId: string, config: LiveEngineConfig, cause: unknown) {
    super(
      `${livePinRejectionReason(engineId, config)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'LivePinRejectedError';
    this.engineId = engineId;
  }
}

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
  'LivePinRejectedError',
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
  // A pin refusal qualifies on its class alone: LivePinRejectedError is only
  // ever raised where a live suite applied the adapter's own pin at session
  // creation, so it is the engine declining that pin on this machine — an
  // environment mismatch, not a code defect. Its message names the value, the
  // file and the override variable, which is the skip reason. A bare
  // ConfigError does NOT qualify: that is a rejection of config a case built
  // itself (e.g. CF-10's creation key), which is a real defect.
  if (className === 'LivePinRejectedError') return true;
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
    !(error instanceof NotInstalledError) &&
    !(error instanceof LivePinRejectedError)
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
 * exclusion. `unexpected:` lines (CLI bugs) never qualify; neither does a
 * bare ConfigError line — the CLI live suite recognises a declined `-c` pin
 * itself, at the session-creation point where the pin was applied.
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
 * The model family each engine must offer live.
 *
 * The gate asserts the family the *probe machine* is configured to serve, so
 * an engine belongs here only once a family has been chosen for it. claude-code
 * has not — the entry it used to lack for a different reason, that it reported
 * no live config options at all, stopped being true at wrapper 0.70.0, which
 * publishes `mode`, `model`, `effort`, `fast` and `agent`. Choosing its family
 * is a configuration decision, not a defect fix; until one is chosen the engine
 * is ungated, which `requiredModelFamilyPresent` already returns true for.
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
 * Whether an engine removes the native session on discard, or only closes
 * locally — the fork in the road ST-DISC-01 and ST-DISC-02 sit either side of.
 *
 * Read from the descriptor rather than from a list of engine ids. The two cases
 * used to name the engines they applied to and then assert the capability,
 * which put the pairing one engine release out of date the moment claude-code's
 * wrapper gained `session/delete`: it sat in the "cannot delete" case, whose
 * own precondition it then failed, while no case exercised what it now does.
 * The same shape CF-08 was fixed for.
 *
 * `=== true` rather than truthiness. Not because the two differ on any legal
 * value — the matrix types the entry `boolean`, so an absent one is `undefined`
 * and falsy either way — but because absent and `false` are both real answers
 * here (opencode does not advertise the verb; pi advertises it `false`) and the
 * comparison says at the call site that the three-way read was intended.
 * @param descriptor - the engine descriptor probed for this live run.
 * @returns true when `session/delete` is advertised.
 */
export function discardsNatively(descriptor: EngineDescriptor): boolean {
  return descriptor.capabilities.session['delete'] === true;
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
  /** False when the engine does not advertise `session/delete` — nothing was
   * attempted. Read at run time, not from a list: claude-code was on that list
   * until its wrapper gained the verb at 0.70.0. */
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
 * and lands in `failed`. opencode and claude-code did not advertise the verb
 * and were skipped wholesale.
 *
 * claude-code has since gained it — measured `session.delete: true` at wrapper
 * 0.70.0 — so it is no longer skipped here, and the deletes this function
 * performs for it have not been observed the way kimi's and codex's were. What
 * decides is the engine's own advertisement, read per run; the 2026-08-08
 * measurement is left as written because it is a record of that day.
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

/**
 * Find a descriptor config option by id, or by category as a fallback.
 * @param d - the engine descriptor.
 * @param id - the option id.
 * @param category - an optional category to match when the id is absent.
 * @returns the option or undefined.
 */
export function configOption(d: EngineDescriptor, id: string, category?: string) {
  return (
    d.configOptions.find((o) => o.id === id) ??
    (category ? d.configOptions.find((o) => o.category === category) : undefined)
  );
}

// ── CF-10 / CF-06: reading a thought level and its effect ──────────────────
//
// These live here rather than in live.ts because live.ts runs every case at
// import time and so cannot be imported by a test. The decisions they encode —
// which two levels count as the extremes, which wire frame carries the turn's
// output tokens, and how much separation counts as an effect — are the ones
// worth holding red-testable without spending a turn on a real engine.

/**
 * The thought-level option an engine publishes, whatever it calls it.
 * @param d - the engine descriptor.
 * @returns the option, or undefined when the engine has none.
 */
export function thoughtLevelOption(d: EngineDescriptor) {
  return (
    configOption(d, 'reasoning_effort', 'thought_level') ?? configOption(d, 'reasoning', 'thought_level')
  );
}

/**
 * Every value a select option offers, flattening groups.
 * @param option - the config option.
 * @returns the values in declaration order.
 */
export function optionValues(option: EngineDescriptor['configOptions'][number]): string[] {
  return (option.options ?? []).flatMap((entry) =>
    'value' in entry ? [entry.value] : entry.options.map((o) => o.value),
  );
}

// Thought-level names ordered least to most. Declaration order is not a
// ranking and never was: opencode lists `none` last and claude-code lists
// `default` first, so reading the last declared value as "the highest" picked
// opencode's weakest setting. `default` is deliberately unranked — it means
// "whatever this model does unasked", which is not a point on the scale, and
// comparing against it measures the model rather than the setting.
export const THOUGHT_LEVEL_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/**
 * The weakest and strongest levels an option advertises, by rank.
 * @param option - the thought-level config option.
 * @returns the two extremes, or undefined when fewer than two values are ranked.
 */
export function thoughtLevelExtremes(
  option: EngineDescriptor['configOptions'][number],
): { low: string; high: string } | undefined {
  const ranked = optionValues(option)
    .filter((v) => THOUGHT_LEVEL_RANK[v] !== undefined)
    .sort((a, b) => THOUGHT_LEVEL_RANK[a]! - THOUGHT_LEVEL_RANK[b]!);
  if (ranked.length < 2) return undefined;
  return { low: ranked[0]!, high: ranked[ranked.length - 1]! };
}

/**
 * How much more the strongest thought level must spend than the weakest before
 * CF-10 counts the setting as having done something.
 *
 * Set from both sides, measured on claude-code. Two negative controls — the
 * case run with both arms writing the same level, so nothing changes — came out
 * 1.95x and 2.59x apart, so a bare inequality, or even a doubling, would have
 * called run-to-run noise a working setting. Six runs at genuinely different
 * levels separated by 18.6x, 74x, 602x, 1638x, 2346x and 3092x. 8x sits about
 * three times above the noise and rather more than twice below the tightest
 * real separation — a real gap, but not a comfortable one at the bottom end,
 * because the weak arm's own output varies (3 to 86 tokens) far more than the
 * strong arm's does. If a run ever lands between 2.6x and 8x, widen the sample
 * before moving this number: one turn each way is a small sample, which is why
 * the case warns rather than fails.
 */
export const THOUGHT_EFFECT_RATIO = 8;

/**
 * The output-token count the engine reported for a turn, read off the wire.
 *
 * The fallback for CF-10's third tier, reached only when `TurnResult.usage` is
 * empty — which is what an engine whose adapter declares no usage mapping
 * leaves behind. The number is on the `session/prompt` response either way, and
 * on some engines it is the only thought-level evidence there is: Anthropic
 * bills thinking inside `output_tokens` rather than breaking it out, so a model
 * that thought harder shows up in that count and nowhere else.
 * @param frames - the frames captured around the turn.
 * @returns the last reported output-token count, or undefined when none was.
 */
export function wireOutputTokens(frames: WireFrame[]): number | undefined {
  let out: number | undefined;
  for (const frame of frames) {
    if (frame.direction !== 'in') continue;
    const usage = (frame.result as { usage?: Record<string, unknown> } | undefined)?.usage;
    const reported = usage?.['outputTokens'];
    if (typeof reported === 'number') out = reported;
  }
  return out;
}
