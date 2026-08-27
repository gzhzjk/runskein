/**
 * Live test-plan runner — the cases that can only be judged against a real
 * engine over real auth. Deliberately outside the default `pnpm test`, which
 * stays mock-only; run this explicitly once engines are authenticated:
 *
 *   pnpm --filter @runskein/conformance test:live [engineId ...]
 *
 * Engines run one at a time, and the default case set is the classic path a
 * host takes: create a session and stream a reply (SL-11), keep the workspace
 * boundary (ST-CWD-01), survive an idle gap and a crash (ST-LIFE-06 with
 * ST-CFG-03, one script judged twice), resume after a mid-turn death (RS-06),
 * and clean up on discard (ST-DISC-01). Six cases per engine.
 *
 * Everything else is opt-in and still emits a skip carrying its opt-in hint,
 * so the summary shows what did not run: LIVE_INCLUDE=<case-id>,
 * LIVE_INCLUDE=e2e-extend, or LIVE_INCLUDE=all. See DEFAULT_WAIVED for the
 * list and the reason each one is on it.
 *
 * Emits the artifacts under `test-results/<run-id>/`:
 *   run-summary.txt / run-summary.jsonl  +  <engine>/<area>/<case>.log
 *
 * Per-engine auth: an engine whose session cannot be created is SKIPped for
 * every case with a structured waiver, never a silent drop.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isPromptEcho,
  jsonlStore,
  ConfigError,
  EngineOperationError,
  NotSupportedError,
  type PermissionPolicy,
  type PermissionRequest,
  type Session,
  type EngineDescriptor,
} from 'runskein';
import { builtinAdapters } from 'runskein';
import { fileOwnershipRegistry, readSessionMeta, type OwnershipRegistry } from '@runskein/core/internal';
// createLiveHub, not the public createHub: the wire trace is an internal seam
// the public factory cannot carry, and it is the only oracle for a claim about
// what an engine actually put on the wire.
import { createLiveHub, type WireFrame } from './index.js';
import {
  collectNativeSessionIds,
  deleteEngineSessions,
  isLiveCaseOptedIn,
  isLiveEnvironmentUnavailable as providerUnavailable,
  liveCaseOptInLabel,
  LIVE_E2E_EXTEND_GROUP,
  LIVE_MODEL_PINS,
  listEngineSessionIds,
  ownedLiveEnginePids,
  requiredModelFamilyPresent,
  withLiveTimeout as timeout,
} from './liveSupport.js';
import { readTokenFields, readUsageUpdate, resolveObjectPath } from './usageSupport.js';
import { runAgentMessageCase } from './message-format-case.js';

/** The usage declaration an engine's adapter carries, if any. */
type UsageMapping = (typeof builtinAdapters)[number]['usage'];

// Every case forces a concrete model per engine from the shared pin table
// (live runs are model-specific). Every engine takes its pin the same way —
// config:{model} at session creation in sessionFor, written through the
// engine's own model surface.

// ── Artifacts ─────────────────────────────────────────────────────────

const gitSha = process.env.GIT_SHA ?? '?';
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + gitSha.slice(0, 7);
const runRoot = resolve(import.meta.dirname, '../../test-results', runId);

type Verdict = 'pass' | 'fail' | 'skip' | 'warn';
interface CaseResult {
  caseId: string;
  engine: string;
  verdict: Verdict;
  log: string[];
  durationMs: number;
  waiver?: string;
}

const results: CaseResult[] = [];

/** Per-turn ceiling for live cases; core sets no timeout on session/prompt. */
const TURN_TIMEOUT_MS = 180_000;

/**
 * Record a case result and write its human-readable log file.
 * @param c - the case result.
 */
function emit(c: CaseResult): void {
  results.push(c);
  const dir = join(runRoot, c.engine, c.caseId.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(11, 23);
  const lines = [
    `━━━ CASE ${c.caseId} [engine=${c.engine}] ${c.verdict.toUpperCase()} ${c.durationMs}ms ━━━`,
    ...c.log.map((l) => `[${stamp}] ${l}`),
  ];
  if (c.waiver) lines.push(`[${stamp}] WAIVER ${c.waiver}`);
  writeFileSync(join(dir, `${c.caseId}.log`), lines.join('\n') + '\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// OpenCode's default permission policy is model/config dependent. Inject an
// adapter-scoped config layer instead of editing the user's config, so the
// live case always exercises ACP request_permission and still answers it
// through runskein's PermissionPolicy.
const OPENCODE_ASK_CONFIG = JSON.stringify({
  permission: {
    read: 'ask',
    edit: 'ask',
    glob: 'ask',
    grep: 'ask',
    list: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    task: 'ask',
    question: 'ask',
    webfetch: 'ask',
  },
});

/**
 * Find a descriptor config option by id, or by category as a fallback.
 * @param d - the engine descriptor.
 * @param id - the option id.
 * @param category - an optional category to match when the id is absent.
 * @returns the option or undefined.
 */
function configOption(d: EngineDescriptor, id: string, category?: string) {
  return (
    d.configOptions.find((o) => o.id === id) ??
    (category ? d.configOptions.find((o) => o.category === category) : undefined)
  );
}

// ── Per-engine session fixture ─────────────────────────────────────────────

interface EngineCtx {
  engine: string;
  hub: ReturnType<typeof createLiveHub>;
  descriptor: EngineDescriptor;
  /** The group's transcript store — read back at teardown to inventory the
   * engine-side sessions this group created (cleanup). */
  store: ReturnType<typeof jsonlStore>;
  /** Exact process ownership records for this runner's crash-injection cases. */
  ownership: OwnershipRegistry;
}

/**
 * Open a hub and probe the engine descriptor for live cases.
 * @param engine - the engine id.
 * @returns the engine context.
 * @throws the describe failure (with cleanup) when the engine is unavailable.
 */
/**
 * Frames of the engine currently being captured, or undefined when disarmed.
 *
 * Armed only around the operation under test: a live run's full traffic is
 * mostly streamed update notifications, and retaining all of it for every
 * engine would cost memory for frames no case reads.
 */
const wireCapture = new Map<string, WireFrame[]>();

/**
 * Record every frame of one engine while `fn` runs.
 * @param ctx - the engine context.
 * @param fn - the operation to observe.
 * @returns the operation's result plus the frames it produced.
 */
async function withWireCapture<T>(
  ctx: EngineCtx,
  fn: () => Promise<T>,
): Promise<{ value: T; frames: WireFrame[] }> {
  const frames: WireFrame[] = [];
  wireCapture.set(ctx.engine, frames);
  try {
    return { value: await fn(), frames };
  } finally {
    wireCapture.delete(ctx.engine);
  }
}

async function openEngine(engine: string): Promise<EngineCtx> {
  const store = jsonlStore(tmp('runskein-live-'));
  const ownership = fileOwnershipRegistry();
  const baseAdapter = builtinAdapters.find((adapter) => adapter.id === engine);
  if (baseAdapter === undefined) throw new Error(`unknown live engine '${engine}'`);
  const hub = createLiveHub({
    store,
    orphanSweep: { ownership },
    ...(engine === 'opencode'
      ? {
          adapters: [
            {
              ...baseAdapter,
              launch: {
                ...baseAdapter.launch,
                env: { ...baseAdapter.launch.env, OPENCODE_CONFIG_CONTENT: OPENCODE_ASK_CONFIG },
              },
            },
          ],
        }
      : {}),
    wireObserver: (engineId: string) => (frame: WireFrame) => {
      wireCapture.get(engineId)?.push(frame);
    },
  });
  try {
    const descriptor = await hub.describe(engine);
    return { engine, hub, descriptor, store, ownership };
  } catch (error) {
    try {
      await hub.quit();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `describe and cleanup failed for ${engine}`);
    }
    throw error;
  }
}

/**
 * `<operation> <engine>` pairs whose ACP request hit core's 30s request
 * timeout and was retried once — recorded for the run summary so retries
 * are never silent.
 */
const timeoutRetries: string[] = [];

/**
 * Run an ACP operation, retrying exactly once when it times out.
 *
 * A loaded machine can push an engine's requests past core's 30s request
 * timeout — less often now that engines run one at a time, but a live run
 * shares the host with whatever else is on it. That is harness-inflicted load,
 * not an engine signal, so a timeout is retried exactly once; any second
 * failure propagates to the case unchanged. (AD-05, the one case that does
 * measure request latency, detects the retry and downgrades a retry-induced
 * budget overage to warn instead of fail.)
 * @param ctx - the engine context.
 * @param operation - the ACP operation name, matched against EngineOperationError.
 * @param fn - the operation to attempt.
 * @returns the operation's result.
 */
async function withOneTimeoutRetry<T>(ctx: EngineCtx, operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const isOpTimeout =
      e instanceof EngineOperationError && e.operation === operation && /timed? ?out/i.test(e.message);
    if (!isOpTimeout) throw e;
    timeoutRetries.push(`${operation} ${ctx.engine}`);
    return await fn();
  }
}

/**
 * Create a session with the engine's forced model applied; session/new is
 * retried once on timeout (see withOneTimeoutRetry).
 * @param ctx - the engine context.
 * @param cwd - the session workspace.
 * @param opts - optional resume id, policy, timeout, and initial config.
 * @returns the session, with the engine's pinned model applied at creation.
 */
async function sessionFor(
  ctx: EngineCtx,
  cwd: string,
  opts: {
    resume?: string;
    permissionPolicy?: PermissionPolicy;
    sessionIdleTimeoutMs?: number;
    config?: Record<string, string | boolean>;
  } = {},
): Promise<ReturnType<typeof ctx.hub.session>> {
  const pin = LIVE_MODEL_PINS[ctx.engine];
  return withOneTimeoutRetry(ctx, 'session/new', () =>
    ctx.hub.session({
      engine: ctx.engine,
      cwd,
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts.permissionPolicy !== undefined ? { permissionPolicy: opts.permissionPolicy } : {}),
      ...(opts.sessionIdleTimeoutMs !== undefined
        ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
        : {}),
      ...(opts.config !== undefined
        ? { config: opts.config }
        : pin !== undefined
          ? { config: { model: pin.model } }
          : {}),
    }),
  );
}

// ── Cases ──────────────────────────────────────────────────────────────────

/**
 * Exercise one engine's message union and tool-call content in one session.
 * Optional protocol messages are reported as warnings because their presence
 * depends on the selected model and engine mode.
 * @param ctx - the live engine context.
 * @param caseId - the emitted conformance case id.
 * @param planMode - the engine mode used for the plan turn.
 * @param buildMode - the engine mode used for tool turns and restored after planning.
 * @param requirements - update kinds and negotiated capabilities this engine must emit.
 */
async function agentMessageFormat(
  ctx: EngineCtx,
  caseId: string,
  planMode: string,
  buildMode: string,
  requirements: {
    requiredUpdateKinds: readonly string[];
    requireDiffs: boolean;
    requireTerminalContent: boolean;
    requirePermissionRequest: boolean;
  },
): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  let session: Session | undefined;
  const permissionRequests: PermissionRequest[] = [];
  const permissionPolicy: PermissionPolicy = (request) => {
    permissionRequests.push(request);
    return { outcome: 'allow' };
  };
  try {
    const cwd = tmp(`runskein-${ctx.engine}-format-`);
    session = await sessionFor(ctx, cwd, { permissionPolicy });
    const result = await runAgentMessageCase({
      session,
      cwd,
      descriptor: ctx.descriptor,
      permissionRequests,
      engineId: ctx.engine,
      planMode,
      buildMode,
      ...requirements,
    });
    await session.close();
    log.push(...result.log, ...result.warnings.map((warning) => `WARN ${warning}`));
    emit({
      caseId,
      engine: ctx.engine,
      verdict: result.warnings.length === 0 ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(result.warnings.length > 0 ? { waiver: 'optional message types depend on the model/mode' } : {}),
    });
  } catch (e) {
    emit({
      caseId,
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  } finally {
    if (session !== undefined && !session.isClosed) {
      try {
        await session.close();
      } catch {
        // The runner's hub cleanup reports any remaining engine failure.
      }
    }
  }
}

/**
 * Raised when a case's control step fails, meaning the property under test was
 * never exercised. Distinct from a failing subject: a control failure says the
 * engine could not do the basic thing the case builds on (read its workspace,
 * run a shell), so reporting a regression would be a false accusation. Observed
 * live when the host's own agent configuration leaked into a claude-code
 * session and the turn was spent on unrelated tooling.
 */
class ControlUntested extends Error {}

/**
 * Run one turn and return the agent's text, so a case can assert on what the
 * model actually said rather than only on the stop reason.
 * @param s - the session to prompt.
 * @param text - the prompt.
 * @param label - timeout label.
 * @returns the concatenated agent text of that turn.
 */
async function promptText(
  s: Awaited<ReturnType<typeof sessionFor>>,
  text: string,
  label: string,
): Promise<string> {
  let reply = '';
  const off = s.on('update', (event) => {
    const u = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
      reply += u.content.text ?? '';
  });
  try {
    await timeout(s.prompt(text), TURN_TIMEOUT_MS, label);
    return reply;
  } finally {
    off();
  }
}

/**
 * Tool-call syntax that arrived as assistant prose instead of a tool call.
 *
 * Engines emit their own markup — pi's model produces `ctx_execute_file(...)`
 * and DSML blocks — and when it lands as text the tool never runs. Not an
 * exhaustive list: it names the shapes actually measured, so a case can say
 * "the tool did not run" instead of guessing at why its result is missing.
 */
const RAW_TOOL_MARKUP = /<｜DSML｜|<ctx_execute_file>|ctx_execute_file\(|tool_calls>/;

/**
 * ST-CWD-01 — per-session cwd isolation for file tools (AC-6.1).
 *
 * Workspace isolation is what lets several agents share one engine process and
 * still work in their own trees, and it rests entirely on engine behaviour that
 * nothing guards: a version bump could regress it silently, and the way that
 * surfaces is a write landing in the wrong worktree. This promotes the one-off
 * experiment into a recurring per-engine case so a regression turns a row red.
 *
 * Two properties carry the case:
 *   - **Relative paths only.** An absolute path would be resolved by the engine
 *     regardless of its working directory, so the case would pass on an engine
 *     that ignores cwd entirely and prove nothing.
 *   - **Session B is the subject.** The process is launched with session A's cwd
 *     (first acquire wins), so A is correct by construction; B is where a
 *     regression appears. A therefore runs as a control: if it fails too, the
 *     engine's file tools are broken or unpermitted and the run says so, rather
 *     than blaming cwd routing.
 *
 * Writes are checked on disk rather than in the reply, including the harness's
 * own cwd, so a stray write is caught instead of merely unobserved.
 * @param ctx - the engine context.
 */
async function stCwd01(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
  const markerA = `CWD-A-${nonce}`;
  const markerB = `CWD-B-${nonce}`;
  const writtenName = `written-${nonce}.txt`;
  try {
    const dirA = tmp('runskein-live-cwd-a-');
    const dirB = tmp('runskein-live-cwd-b-');
    writeFileSync(join(dirA, 'marker.txt'), `${markerA}\n`);
    writeFileSync(join(dirB, 'marker.txt'), `${markerB}\n`);

    // A first: it decides the process cwd, which is exactly why B is the subject.
    const a = await sessionFor(ctx, dirA);
    const b = await sessionFor(ctx, dirB);
    log.push('STEP 1/4 two sessions shared one process');

    const readPrompt =
      'Read the file `marker.txt` in your current working directory using the ' +
      'relative path `marker.txt`. Do not use an absolute path. Reply with its ' +
      'exact contents and nothing else.';

    // Control: proves the engine can read its workspace at all in this run.
    const aReply = await promptText(a, readPrompt, 'cwd01 control read');
    const controlOk = aReply.includes(markerA);
    log.push(`STEP 2/4 control (session A) read own marker=${controlOk}`);
    if (!controlOk) {
      throw new ControlUntested(
        `session A could not read its own marker via a relative path — file tools ` +
          `unusable, so cwd routing is untested. reply=${aReply.slice(0, 200)}`,
      );
    }

    // Subject: the session whose cwd is NOT the process cwd.
    const bReply = await promptText(b, readPrompt, 'cwd01 subject read');
    const readOwn = bReply.includes(markerB);
    const readSibling = bReply.includes(markerA);
    log.push(`STEP 3/4 subject (session B) readOwn=${readOwn} readSibling=${readSibling}`);
    if (!readOwn || readSibling) {
      // Two different failures wear the same result. Reading the sibling's
      // marker is the cwd defect this case exists for. Reading neither can be
      // that too — or the tool never ran, which is what a model emitting its
      // tool-call syntax as prose produces (measured on pi, note 031). Saying
      // "wrong directory" for both sends the next reader after the wrong bug.
      const neverRan = !readOwn && !readSibling && RAW_TOOL_MARKUP.test(bReply);
      throw new Error(
        (neverRan
          ? `session B produced tool-call syntax as text instead of invoking the tool, so nothing was read`
          : `session B resolved a relative read from the wrong directory`) +
          ` (own=${readOwn}, sibling=${readSibling}): ${bReply.slice(0, 200)}`,
      );
    }

    await promptText(
      b,
      `Create a file named \`${writtenName}\` in your current working directory using ` +
        `that exact relative path, containing only the text ${markerB}. Do not use an ` +
        'absolute path. Reply with just the word DONE.',
      'cwd01 subject write',
    );
    const landedInB = existsSync(join(dirB, writtenName));
    const strayInA = existsSync(join(dirA, writtenName));
    const strayInHost = existsSync(join(process.cwd(), writtenName));
    log.push(`STEP 4/4 write landedInB=${landedInB} strayInA=${strayInA} strayInHost=${strayInHost}`);
    if (!landedInB || strayInA || strayInHost) {
      throw new Error(
        `session B's relative write landed wrong (inB=${landedInB}, inA=${strayInA}, ` +
          `inHostCwd=${strayInHost})`,
      );
    }

    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    emit({ caseId: 'ST-CWD-01', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    const untested = e instanceof ControlUntested;
    const unavailable = untested || providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    emit({
      caseId: 'ST-CWD-01',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(untested
        ? { waiver: 'control step failed — engine could not exercise the path, so cwd routing is untested' }
        : unavailable
          ? { waiver: 'typed engine auth/start/network unavailability' }
          : {}),
    });
  }
}

/**
 * ST-CWD-02 — per-session cwd isolation for the engine's shell tool (AC-6.2).
 *
 * The file-tool path was measured long ago; the shell path is a separate
 * implementation per engine, and a build or test run in the wrong tree damages
 * exactly like a misplaced write. Measured across all four engines (note 023),
 * which is why shell cwd stayed Core and no Negotiated capability shipped —
 * this is the guard that keeps that ruling honest.
 *
 * Caveat worth keeping in view: this measures where the engine's shell
 * *starts*, not where it can *reach*. Nothing stops an engine-run command from
 * touching an absolute path elsewhere; per-session cwd remains a cooperative
 * guarantee, and container isolation is the only enforceable one.
 *
 * An execute-kind tool call must be observed, otherwise a model that answered
 * from memory would pass a case about where a subprocess actually ran.
 * @param ctx - the engine context.
 */
async function stCwd02(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const dirA = tmp('runskein-live-shell-a-');
    const dirB = tmp('runskein-live-shell-b-');
    const realA = realpathSync(dirA);
    const realB = realpathSync(dirB);
    const a = await sessionFor(ctx, dirA);
    const b = await sessionFor(ctx, dirB);

    const shellPrompt =
      'Run the shell command `pwd` using your terminal or command-execution tool, ' +
      'then reply with exactly the one line it printed and nothing else. ' +
      'Do not answer from memory — you must actually run the command.';

    /**
     * Prompt one session and report what it said plus whether a shell ran.
     * @param s - the session to drive.
     * @param label - log label.
     * @returns the reply text and whether an execute-kind tool call was seen.
     */
    const probe = async (
      s: Awaited<ReturnType<typeof sessionFor>>,
      label: string,
    ): Promise<{ reply: string; sawShell: boolean }> => {
      let sawShell = false;
      const off = s.on('update', (event) => {
        const u = event.update as { sessionUpdate?: string; kind?: string; title?: string };
        if (
          u?.sessionUpdate === 'tool_call' &&
          (u.kind === 'execute' || /pwd|bash|shell|terminal/i.test(u.title ?? ''))
        ) {
          sawShell = true;
        }
      });
      try {
        return { reply: await promptText(s, shellPrompt, label), sawShell };
      } finally {
        off();
      }
    };

    const controlProbe = await probe(a, 'cwd02 control pwd');
    const controlOk = controlProbe.reply.includes(realA) || controlProbe.reply.includes(dirA);
    log.push(`STEP 1/2 control (session A) correct=${controlOk} shellTool=${controlProbe.sawShell}`);
    if (!controlOk) {
      throw new ControlUntested(
        `session A did not report its own cwd, so the shell path is untested rather ` +
          `than broken. reply=${controlProbe.reply.slice(0, 200)}`,
      );
    }

    const subject = await probe(b, 'cwd02 subject pwd');
    const reportedOwn = subject.reply.includes(realB) || subject.reply.includes(dirB);
    const reportedSibling = subject.reply.includes(realA) || subject.reply.includes(dirA);
    log.push(
      `STEP 2/2 subject (session B) own=${reportedOwn} sibling=${reportedSibling} shellTool=${subject.sawShell}`,
    );
    if (!subject.sawShell) {
      throw new Error('no execute-kind tool call observed — the reply may be memory, not a shell run');
    }
    if (!reportedOwn || reportedSibling) {
      throw new Error(
        `session B's shell started in the wrong directory (own=${reportedOwn}, ` +
          `sibling=${reportedSibling}): ${subject.reply.slice(0, 200)}`,
      );
    }

    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    emit({ caseId: 'ST-CWD-02', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    const untested = e instanceof ControlUntested;
    const unavailable = untested || providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    emit({
      caseId: 'ST-CWD-02',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(untested
        ? { waiver: 'control step failed — engine could not exercise the path, so cwd routing is untested' }
        : unavailable
          ? { waiver: 'typed engine auth/start/network unavailability' }
          : {}),
    });
  }
}

/**
 * ST-LIFE-06 (AC-2.1, AC-2.3) + ST-CFG-03 — one interrupted conversation,
 * judged twice.
 *
 * The live twin of the hermetic lifetime cases. Those can prove identity, tier
 * and turn success, but not that the conversation actually survived: only a
 * real model can be asked what it was told before the gap. A codeword planted
 * before the release and recalled after it is the difference between "a session
 * object still works" and "the session is still the same conversation".
 *
 * Two gaps in sequence, because they fail differently: an idle release is
 * orderly and runskein chooses when it happens, while an external kill is not.
 *
 * The second oracle rides the same turns. The desired model is written before
 * each transition, and the wire trace is armed only around the first prompt
 * after recovery — which keeps it independent of configState(), maintained by
 * the same host code this case is meant to catch.
 *
 * Both cases were always this one script; running it twice per engine bought
 * the second oracle at twice the tokens. They keep separate case ids because
 * the test plan tracks them separately and each fails on its own: a session
 * that recovers its context while losing its config is exactly the kind of
 * half-recovery worth naming precisely.
 * @param ctx - the live engine context.
 */
async function stLifetimeRecovery(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  // The prefix is named, not sliced back out of the codeword: the recall
  // prompt quotes it so the engine knows which token is being asked for, and
  // deriving it with indexOf would quietly produce an empty hint the day the
  // format changes.
  const codewordPrefix = 'LIFE-';
  const codeword = `${codewordPrefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const pin = LIVE_MODEL_PINS[ctx.engine];
  let session: Session | undefined;

  /**
   * Emit the same verdict for both cases, for the failures that belong to the
   * shared script rather than to either oracle.
   * @param verdict - pass, fail or skip.
   * @param extra - lines appended to the shared log.
   * @param waiver - waiver text, when the environment is at fault.
   */
  const emitBoth = (verdict: 'fail' | 'skip', extra: string[], waiver?: string): void => {
    for (const caseId of ['ST-LIFE-06', 'ST-CFG-03']) {
      emit({
        caseId,
        engine: ctx.engine,
        verdict,
        log: [...log, ...extra],
        durationMs: Date.now() - t0,
        ...(waiver !== undefined ? { waiver } : {}),
      });
    }
  };

  try {
    // Only the config oracle needs a pin. LIFE-06 asks whether the
    // conversation survived, which is true of whatever model the engine
    // chooses, so an engine with no pin still runs it and CFG-03 waives —
    // the preconditions each case had before they shared a script.
    session = await withOneTimeoutRetry(ctx, 'session/new', () =>
      ctx.hub.session({
        engine: ctx.engine,
        cwd: tmp('runskein-live-life-'),
        sessionIdleTimeoutMs: 2_000,
        ...(pin !== undefined ? { config: { model: pin.model } } : {}),
      }),
    );
    let reply = '';
    session.on('update', (event) => {
      const u = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
        reply += u.content.text ?? '';
    });
    const tiers: string[] = [];
    session.on('reactivated', (info) => tiers.push(info.tier));

    // Both prompts are worded to keep the acknowledgement token away from the
    // codeword: measured on pi/DeepSeek-V4-Flash, a plant that asked for "OK"
    // in the same breath as the codeword got "the codeword was OK" back on
    // recall — the context had survived, the two tokens had merged. So the
    // plant forbids repeating the codeword now, and the recall names the
    // codeword's prefix so there is only one string that fits.
    await timeout(
      session.prompt(
        `Remember this codeword for later: ${codeword}. Do not repeat the codeword now — reply with just the word ACK.`,
      ),
      TURN_TIMEOUT_MS,
      'lifetime plant',
    );
    log.push(
      `STEP 1/5 planted ${codeword}, model ${pin === undefined ? 'left to the engine' : `pinned to ${pin.model}`}`,
    );

    /**
     * Prompt for the codeword while capturing the wire, so one turn answers
     * both questions.
     * @param label - timeout label for the turn.
     * @returns whether the codeword came back, and the acknowledged config writes.
     */
    const recall = async (label: string): Promise<{ recalled: boolean; writes: number; reply: string }> => {
      reply = '';
      const captured = await withWireCapture(ctx, () =>
        timeout(
          session!.prompt(
            `Repeat the codeword I asked you to remember earlier. It starts with "${codewordPrefix}". ` +
              `Reply with just that codeword and nothing else.`,
          ),
          TURN_TIMEOUT_MS,
          label,
        ),
      );
      return {
        recalled: reply.includes(codeword),
        writes: acknowledgedConfigWrites(captured.frames).length,
        // Kept in the log: "not recalled" is a verdict, not evidence. What the
        // engine actually said is the difference between a model that forgot
        // and one that answered in a shape nothing could read.
        reply: reply.trim().slice(0, 120),
      };
    };

    // Past the threshold on a real clock, so the session really lets go.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    log.push('STEP 2/5 idled past the session threshold');
    const afterIdle = await recall('lifetime recall after idle');
    log.push(
      `STEP 3/5 after idle: recalled=${afterIdle.recalled} configWrites=${afterIdle.writes} tiers=[${tiers.join(',')}] reply=${JSON.stringify(afterIdle.reply)}`,
    );

    // Now the disorderly gap: kill the engine out from under the session. The
    // host never calls resume — the next prompt is expected to handle it.
    const killed = await killEngineChildren(ctx);
    if (killed === 0) throw new Error('could not locate the engine process for crash recovery');
    log.push(`STEP 4/5 killed ${killed} engine process(es) externally`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const afterKill = await recall('lifetime recall after kill');
    log.push(
      `STEP 5/5 after kill: recalled=${afterKill.recalled} configWrites=${afterKill.writes} tiers=[${tiers.join(',')}] reply=${JSON.stringify(afterKill.reply)}`,
    );

    await session.close().catch(() => undefined);

    // Each oracle judged on its own, from the one run.
    const contextHeld = afterIdle.recalled && afterKill.recalled;
    emit({
      caseId: 'ST-LIFE-06',
      engine: ctx.engine,
      verdict: contextHeld ? 'pass' : 'fail',
      log: contextHeld
        ? log
        : [
            ...log,
            `FAIL codeword ${codeword} not recalled (idle=${afterIdle.recalled} kill=${afterKill.recalled})`,
          ],
      durationMs: Date.now() - t0,
    });
    if (pin === undefined) {
      // Nothing was pinned, so there is no desired config for recovery to
      // re-apply and nothing this oracle could observe.
      emit({
        caseId: 'ST-CFG-03',
        engine: ctx.engine,
        verdict: 'skip',
        log: [...log, 'INFO  no model pin for this engine; nothing to re-apply'],
        durationMs: Date.now() - t0,
        waiver: 'no model pin configured for this engine',
      });
    } else {
      const configHeld = afterIdle.writes > 0 && afterKill.writes > 0;
      emit({
        caseId: 'ST-CFG-03',
        engine: ctx.engine,
        verdict: configHeld ? 'pass' : 'fail',
        log: configHeld
          ? log
          : [
              ...log,
              `FAIL desired model not re-applied on the wire (idle=${afterIdle.writes} kill=${afterKill.writes})`,
            ],
        durationMs: Date.now() - t0,
      });
    }
  } catch (e) {
    const unavailable = providerUnavailable(e);
    emitBoth(
      unavailable ? 'skip' : 'fail',
      [`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`],
      unavailable ? 'typed engine auth/start/network unavailability' : undefined,
    );
  } finally {
    if (session !== undefined && !session.isClosed) await session.close().catch(() => undefined);
  }
}

/** Return config writes whose ACP response was an acknowledgement, not an error. */
function acknowledgedConfigWrites(frames: WireFrame[]): WireFrame[] {
  const methods = new Set(['session/set_model', 'session/set_config_option']);
  return frames.filter(
    (request) =>
      request.direction === 'out' &&
      request.method !== undefined &&
      methods.has(request.method) &&
      frames.some(
        (response) =>
          response.direction === 'in' &&
          response.method === undefined &&
          response.id === request.id &&
          response.error === undefined,
      ),
  );
}

/**
 * ST-DISC-01 — supported engines remove the native session after discard.
 * @param ctx - the live engine context.
 */
async function stDisc01(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  let session: Awaited<ReturnType<typeof sessionFor>> | undefined;
  try {
    if (!['kimi', 'codex'].includes(ctx.engine)) {
      emit({
        caseId: 'ST-DISC-01',
        engine: ctx.engine,
        verdict: 'skip',
        log: ['INFO case is scoped to kimi and codex'],
        durationMs: 0,
        waiver: 'engine-specific discard matrix',
      });
      return;
    }
    const adapter = builtinAdapters.find((candidate) => candidate.id === ctx.engine);
    if (adapter === undefined) throw new Error(`missing adapter ${ctx.engine}`);
    if (ctx.descriptor.capabilities.session['delete'] !== true) {
      throw new Error(`${ctx.engine} does not advertise session/delete`);
    }
    const before = new Set(await collectNativeSessionIds(ctx.store, ctx.engine));
    session = await sessionFor(ctx, tmp(`runskein-live-disc-${ctx.engine}-`));
    await timeout(session.prompt('Reply with exactly DISCARD-OK.'), TURN_TIMEOUT_MS, 'disc01 prompt');
    const after = await collectNativeSessionIds(ctx.store, ctx.engine);
    const nativeId = after.find((id) => !before.has(id));
    if (nativeId === undefined) throw new Error('could not identify the created native session id');
    await session.close({ discard: true });
    log.push(`STEP 1/2 discarded native session ${nativeId}`);

    const listing = await listEngineSessionIds(adapter);
    if (!listing.supported) throw new Error('session/list is required for the discard oracle');
    const remains = listing.ids.includes(nativeId);
    log.push(`STEP 2/2 session/list contains native id=${remains}`);
    if (remains) throw new Error(`native session ${nativeId} remained after discard`);
    emit({ caseId: 'ST-DISC-01', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    const unavailable = providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    emit({
      caseId: 'ST-DISC-01',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
    });
  } finally {
    if (session !== undefined && !session.isClosed) await session.close().catch(() => undefined);
  }
}

/**
 * ST-DISC-02 — engines without delete close locally and reject discard.
 * @param ctx - the live engine context.
 */
async function stDisc02(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  let session: Awaited<ReturnType<typeof sessionFor>> | undefined;
  try {
    if (!['opencode', 'claude-code'].includes(ctx.engine)) {
      emit({
        caseId: 'ST-DISC-02',
        engine: ctx.engine,
        verdict: 'skip',
        log: ['INFO case is scoped to opencode and claude-code'],
        durationMs: 0,
        waiver: 'engine-specific discard matrix',
      });
      return;
    }
    if (ctx.descriptor.capabilities.session['delete'] === true) {
      throw new Error(`${ctx.engine} unexpectedly advertises session/delete`);
    }
    session = await sessionFor(ctx, tmp(`runskein-live-disc-${ctx.engine}-`));
    await timeout(
      session.prompt('Reply with exactly DISCARD-UNSUPPORTED.'),
      TURN_TIMEOUT_MS,
      'disc02 prompt',
    );
    const outcome = await withWireCapture(ctx, async () => {
      try {
        await session!.close({ discard: true });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    if (!(outcome.value instanceof NotSupportedError)) {
      throw new Error(`expected NotSupportedError, got ${String(outcome.value)}`);
    }
    const sentDelete = outcome.frames.some(
      (frame) => frame.direction === 'out' && frame.method === 'session/delete',
    );
    log.push(`STEP 1/2 discard rejected as NotSupportedError; delete sent=${sentDelete}`);
    if (sentDelete || !session.isClosed)
      throw new Error('unsupported discard did not close locally without deleting');
    emit({ caseId: 'ST-DISC-02', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    const unavailable = providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    emit({
      caseId: 'ST-DISC-02',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
    });
  } finally {
    if (session !== undefined && !session.isClosed) await session.close().catch(() => undefined);
  }
}

/**
 * UA-LIVE-01 — the adapter-declared usage mapping matches the real wire
 * (test plan §3). Judged on the frames ST-QUOTA-02 already captured: no new
 * turn, no new session. Throws on a failed oracle; returns 'warn' for the
 * soft oracle (engine started reporting without a declaration).
 * @param engine - the live engine id.
 * @param opts - prompt response result, captured frames, public usage, log.
 * @returns 'pass' or 'warn' — every hard failure throws instead.
 * @throws Error when a declared source does not resolve on the wire, resolves
 *   to nothing numeric, or its numbers never reached the public surface.
 */
function judgeDeclaredUsage(
  engine: string,
  opts: {
    promptResponse: unknown;
    frames: WireFrame[];
    turnUsage: unknown;
    sessionUsage: unknown;
    log: string[];
  },
): 'pass' | 'warn' {
  const mapping = builtinAdapters.find((a) => a.id === engine)?.usage;
  const payloads = opts.frames
    .filter((f) => {
      if (f.direction !== 'in' || f.method !== 'session/update') return false;
      const update = (f.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
      return update?.sessionUpdate === 'usage_update';
    })
    .map((f) => (f.params as { update: Record<string, unknown> }).update);

  // Oracles 3/4: an engine that declares nothing. Wire tokens it did NOT
  // account are worth seeing (the engine can now be declared); tokens the
  // built-in alias table already reads — pi's nested usage_update.usage, for
  // instance — are already on the public surface, so warning would cry wolf
  // every run; their absence is the quiet pass.
  if (mapping === undefined) {
    const accounted = opts.sessionUsage as Record<string, unknown> | undefined;
    const unread = payloads.some((p) =>
      readUsageUpdate(p).fields.some((f) => typeof accounted?.[f] !== 'number'),
    );
    if (unread) {
      opts.log.push(
        'UA-LIVE-01 wire carries token fields the accounting never read; the adapter can now declare them',
      );
      return 'warn';
    }
    if (payloads.some((p) => readUsageUpdate(p).fields.length > 0)) {
      opts.log.push(
        'UA-LIVE-01 adapter declares nothing; wire token fields are already read through the built-in table',
      );
      return 'pass';
    }
    opts.log.push('UA-LIVE-01 adapter declares nothing and the wire carries none — absent stays absent');
    return 'pass';
  }

  // Oracle 1: the declared source must resolve on this very turn's wire, with
  // at least one declared-or-built-in token field numeric.
  let report: Record<string, unknown> | undefined;
  let reading: ReturnType<typeof readTokenFields>;
  if (mapping.source.kind === 'prompt_response_meta') {
    report = resolveObjectPath(opts.promptResponse, mapping.source.path);
    if (report === undefined) {
      throw new Error(
        `declared path '${mapping.source.path.join('.')}' did not resolve on the captured prompt response`,
      );
    }
    // The resolved object's own shape is authoritative — no nested-`usage`
    // descent, matching core's foldUsageReport (not foldUsage).
    reading = readTokenFields(report, mapping.tokens);
  } else {
    report = payloads.find((p) => readUsageUpdate(p, mapping.tokens).fields.length > 0);
    if (report === undefined) {
      throw new Error('declared source usage_update but no token-bearing usage_update was observed');
    }
    reading = readUsageUpdate(report, mapping.tokens);
  }
  if (reading.fields.length === 0) {
    throw new Error(`declared source resolved but no built-in or declared token field was numeric there`);
  }
  opts.log.push(
    `UA-LIVE-01 declared ${mapping.source.kind} resolved ${reading.fields.join(',')} = ${JSON.stringify(reading.values)}`,
  );

  // Oracle 2: those numbers reached the public surface, field by field. The
  // frame is the oracle, not runskein's parsed copy (same reasoning as the quota
  // passthrough assertion above). A per-turn engine's TurnResult.usage IS the
  // resolved report; a cumulative counter may have moved on, so there only
  // presence is claimed.
  const publicUsage = (mapping.semantics === 'per-turn' ? opts.turnUsage : opts.sessionUsage) as
    Record<string, unknown> | undefined;
  if (publicUsage === undefined) {
    throw new Error(`public usage is absent although the wire resolved ${reading.fields.join(',')}`);
  }
  for (const field of reading.fields) {
    if (typeof publicUsage[field] !== 'number') {
      throw new Error(
        `field '${field}' resolved on the wire (${String(reading.values[field])}) but never reached the public surface`,
      );
    }
    if (mapping.semantics === 'per-turn' && publicUsage[field] !== reading.values[field]) {
      throw new Error(
        `field '${field}': TurnResult.usage=${String(publicUsage[field])} differs from the wire (${String(reading.values[field])})`,
      );
    }
  }
  opts.log.push(`UA-LIVE-01 numbers reached the public surface (${mapping.semantics})`);
  return 'pass';
}

/**
 * ST-QUOTA-02 — TurnResult.quota mirrors the wire, or is absent (AC-5.1) —
 * with UA-LIVE-01 riding the same captured turn as a separately-emitted case
 * (the ST-LIFE-06 + ST-CFG-03 precedent: one script, two verdicts).
 *
 * The oracle is the prompt response frame itself, not runskein's parsed copy:
 * asserting a passthrough against the same bookkeeping that performed it would
 * only prove runskein agrees with itself. Measured beforehand (note 024): codex is
 * the only engine that reports `_meta.quota`; opencode sends an empty `_meta`;
 * kimi and claude-code send none. So the wire decides what to expect, and the
 * per-engine expectation is derived, not hard-coded — an engine that starts or
 * stops reporting moves the wire and the assertion together.
 *
 * Note what codex's blob is: a per-turn token count, not a remaining
 * allowance. The case asserts fidelity of passthrough, never headroom.
 * @param ctx - the engine context.
 */
async function stQuota02(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-quota-'));
    log.push('STEP 1/3 session created');

    const { value: result, frames } = await withWireCapture(ctx, () =>
      timeout(s.prompt('Reply with exactly the word OK. Use no tools.'), 180_000, 'quota prompt'),
    );
    log.push(`STEP 2/3 turn done stopReason=${result.stopReason} frames=${frames.length}`);

    // Pair the prompt request with its response by JSON-RPC id.
    const request = frames.find((f) => f.direction === 'out' && f.method === 'session/prompt');
    if (request?.id === undefined) throw new Error('no session/prompt request frame was captured');
    const response = frames.find((f) => f.direction === 'in' && f.id === request.id && 'result' in f);
    if (response === undefined) throw new Error('no session/prompt response frame was captured');

    const wireResult = response.result as Record<string, unknown> | undefined;
    const wireMeta = wireResult?.['_meta'] as Record<string, unknown> | undefined;
    const wireReports = wireMeta !== undefined && 'quota' in wireMeta;
    log.push(
      `STEP 3/3 wire _meta=${wireMeta === undefined ? 'absent' : JSON.stringify(wireMeta).slice(0, 80)} reportsQuota=${wireReports}`,
    );

    // Each id is judged on its own; only setup above is shared. A quota
    // mismatch must not drag the usage verdict with it or vice versa.
    let quotaError: Error | undefined;
    try {
      if (wireReports) {
        if (result.quota === undefined) {
          throw new Error('engine reported _meta.quota on the wire but TurnResult.quota is absent');
        }
        if (result.quota.engineId !== ctx.engine) {
          throw new Error(`quota.engineId=${result.quota.engineId} does not name the reporting engine`);
        }
        // Byte-equivalence against the frame: any normalization, re-keying or
        // dropped field shows up as a string mismatch.
        const onWire = JSON.stringify(wireMeta!['quota']);
        const passedThrough = JSON.stringify(result.quota.payload);
        if (onWire !== passedThrough) {
          throw new Error(
            `quota payload differs from the wire\n  wire: ${onWire}\n  turn: ${passedThrough}`,
          );
        }
        log.push(`PASS quota passed through verbatim (${onWire.length} chars)`);
      } else {
        // The stricter half. An empty `_meta` (opencode) must still yield an
        // ABSENT field: an empty object would read as "the engine reported
        // nothing left" rather than "the engine never said".
        if (result.quota !== undefined) {
          throw new Error(
            `engine reported no _meta.quota but TurnResult.quota is present: ${JSON.stringify(result.quota)}`,
          );
        }
        // Back-fill prohibition, keyed off the wire rather than off TurnResult:
        // an engine that streams usage_update must have it accounted as Usage and
        // still report no quota. Reading `result.usage` alone would make this
        // vacuous whenever the update lands after the turn resolves, which is
        // exactly what happened on opencode the first time this ran.
        const sawUsageUpdate = frames.some((f) => {
          if (f.direction !== 'in' || f.method !== 'session/update') return false;
          const params = f.params as { update?: { sessionUpdate?: string } } | undefined;
          return params?.update?.sessionUpdate === 'usage_update';
        });
        const accounted = s.usage();
        log.push(
          `PASS quota absent; usage_update on wire=${sawUsageUpdate}; accounted=${JSON.stringify(accounted).slice(0, 100)}`,
        );
        if (sawUsageUpdate) {
          const totals = accounted as Record<string, unknown>;
          const hasNumbers = Object.values(totals).some((v) => typeof v === 'number' && v > 0);
          if (!hasNumbers) {
            throw new Error(
              `engine streamed usage_update but s.usage() accounts nothing: ${JSON.stringify(accounted)}`,
            );
          }
          log.push('PASS usage accounted while quota stays absent — no back-fill');
        }
      }
    } catch (e) {
      quotaError = e as Error;
      log.push(`${providerUnavailable(e) ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    }

    let uaOutcome: 'pass' | 'warn' | undefined;
    let uaError: Error | undefined;
    try {
      uaOutcome = judgeDeclaredUsage(ctx.engine, {
        promptResponse: wireResult,
        frames,
        turnUsage: result.usage,
        sessionUsage: s.usage(),
        log,
      });
    } catch (e) {
      uaError = e as Error;
      log.push(`${providerUnavailable(e) ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    }

    await s.close().catch(() => undefined);
    emit({
      caseId: 'ST-QUOTA-02',
      engine: ctx.engine,
      verdict: quotaError === undefined ? 'pass' : providerUnavailable(quotaError) ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(quotaError !== undefined && providerUnavailable(quotaError)
        ? { waiver: 'typed engine auth/start/network unavailability' }
        : {}),
    });
    emit({
      caseId: 'UA-LIVE-01',
      engine: ctx.engine,
      verdict:
        uaError !== undefined ? (providerUnavailable(uaError) ? 'skip' : 'fail') : (uaOutcome ?? 'fail'),
      log,
      durationMs: Date.now() - t0,
      ...(uaError !== undefined && providerUnavailable(uaError)
        ? { waiver: 'typed engine auth/start/network unavailability' }
        : {}),
    });
  } catch (e) {
    // Shared setup failed (session create, prompt, frame pairing): both ids
    // answer for it, with waiver parity.
    const unavailable = providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    for (const caseId of ['ST-QUOTA-02', 'UA-LIVE-01']) {
      emit({
        caseId,
        engine: ctx.engine,
        verdict: unavailable ? 'skip' : 'fail',
        log,
        durationMs: Date.now() - t0,
        ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
      });
    }
  }
}

/**
 * Verify a session + a short turn work, proving live auth; waives otherwise.
 * @param ctx - the engine context.
 * @returns true when the engine is available and the remaining cases may run.
 */
async function availabilityCheck(ctx: EngineCtx): Promise<boolean> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    log.push(`STEP 1/2 session created (${Date.now() - t0}ms)`);
    const r = await timeout(
      s.prompt('Reply with exactly the word OK. Use no tools.'),
      180_000,
      'availability prompt',
    );
    log.push(`STEP 2/2 prompt → stopReason=${r.stopReason}`);
    await s.close();
    emit({ caseId: 'LIVE-AUTH', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
    return true;
  } catch (e) {
    const unavailable = providerUnavailable(e);
    log.push(`${unavailable ? 'INFO  unavailable' : 'FAIL'}: ${(e as Error).message}`);
    emit({
      caseId: 'LIVE-AUTH',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
    });
    return false;
  }
}

/**
 * CF-05: the live model list contains the engine family and a listed model runs.
 * @param ctx - the engine context.
 */
async function cf05ModelList(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  // The live model list spans two surfaces: a model config option (opencode,
  // kimi, codex) and/or session/new's models (claude-code's only surface;
  // codex advertises both). Gate whichever the engine publishes.
  const option = configOption(ctx.descriptor, 'model', 'model');
  const values = [
    ...((option?.options as { value: string }[] | undefined)?.map((o) => o.value) ?? []),
    ...(ctx.descriptor.models?.map((m) => m.id) ?? []),
  ];
  if (ctx.descriptor.source === 'hints') {
    // An engine that reports model options only as static hints cannot switch
    // models live; none of the bundled engines does this any more, but the
    // fallback stays for third-party adapters.
    emit({
      caseId: 'CF-05',
      engine: ctx.engine,
      verdict: 'skip',
      log: ['INFO  model config is hints-only; live model switching unsupported'],
      durationMs: Date.now() - t0,
      waiver: 'matrix: model config from hints only',
    });
    return;
  }
  if (!requiredModelFamilyPresent(ctx.engine, values)) {
    emit({
      caseId: 'CF-05',
      engine: ctx.engine,
      verdict: 'fail',
      log: [`FAIL no ${ctx.engine}-family model in the live model list`],
      durationMs: Date.now() - t0,
    });
    return;
  }
  try {
    const forced = LIVE_MODEL_PINS[ctx.engine]!.model;
    if (!values.includes(forced)) {
      emit({
        caseId: 'CF-05',
        engine: ctx.engine,
        verdict: 'fail',
        log: [`FAIL forced model ${forced} not in the live model list`],
        durationMs: Date.now() - t0,
      });
      return;
    }
    log.push(`STEP 1/2 live model list contains the ${ctx.engine} family`);
    log.push(`INFO  running with forced model: ${forced}`);
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const r = await timeout(s.prompt('Reply with the single word OK.'), 180_000, 'cf05 prompt');
    log.push(`STEP 2/2 config model=${forced} → stopReason=${r.stopReason}`);
    await s.close();
    emit({ caseId: 'CF-05', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    const unavailable = providerUnavailable(e);
    emit({
      caseId: 'CF-05',
      engine: ctx.engine,
      verdict: unavailable ? 'warn' : 'fail',
      log: [...log, `${unavailable ? 'WARN' : 'FAIL'} ${(e as Error).message}`],
      durationMs: Date.now() - t0,
      ...(unavailable
        ? { waiver: 'typed auth/provider/network failure for the selected listed model' }
        : {}),
    });
  }
}

/**
 * CF-06: lowest and highest thought levels are both accepted.
 * @param ctx - the engine context.
 */
async function cf06ThoughtLevels(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  const option =
    configOption(ctx.descriptor, 'reasoning_effort', 'thought_level') ??
    configOption(ctx.descriptor, 'reasoning', 'thought_level');
  const values = (option?.options as { value: string }[] | undefined)?.map((o) => o.value) ?? [];
  if (ctx.descriptor.source === 'hints' || option === undefined || values.length < 2) {
    // Matrix: claude-code reports no live thought_level config; hint-only
    // options cannot be switched via setConfig.
    emit({
      caseId: 'CF-06',
      engine: ctx.engine,
      verdict: 'skip',
      log: ['INFO  engine reports no live thought_level option'],
      durationMs: Date.now() - t0,
      waiver: 'matrix: no live thought_level option',
    });
    return;
  }
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    let rejected: string | undefined;
    for (const [label, value] of [
      ['lowest', values[0]!],
      ['highest', values[values.length - 1]!],
    ] as const) {
      try {
        await s.setConfig({ reasoning: value });
        log.push(`STEP ${rejected === undefined ? '1/2' : '2/2'} reasoning=${value} accepted`);
      } catch (e) {
        if (e instanceof ConfigError) throw e; // core-side: value not advertised
        // A specific forced model can reject an advertised extreme (e.g. a
        // coding variant with a narrower reasoning range) — record, not fail.
        rejected ??= `${label} reasoning=${value}`;
        log.push(
          `INFO  reasoning=${value} rejected by the forced model (${(e as Error).message.slice(0, 80)})`,
        );
      }
    }
    await s.close();
    emit({
      caseId: 'CF-06',
      engine: ctx.engine,
      verdict: rejected === undefined ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(rejected !== undefined
        ? { waiver: `forced model does not accept an advertised thought level (${rejected})` }
        : {}),
    });
  } catch (e) {
    emit({
      caseId: 'CF-06',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * CF-07: fast-mode off/on accepted (codex only; others skip).
 * @param ctx - the engine context.
 */
async function cf07FastMode(ctx: EngineCtx): Promise<void> {
  if (ctx.engine !== 'codex') {
    emit({
      caseId: 'CF-07',
      engine: ctx.engine,
      verdict: 'skip',
      log: ['INFO  cx-only'],
      durationMs: 0,
      waiver: 'matrix: codex only',
    });
    return;
  }
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    await s.setConfig({ 'fast-mode': 'off' });
    log.push(`STEP 1/2 fast-mode=off accepted`);
    await s.setConfig({ 'fast-mode': 'on' });
    log.push(`STEP 2/2 fast-mode=on accepted`);
    await s.close();
    emit({ caseId: 'CF-07', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    emit({
      caseId: 'CF-07',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * PE-07: every advertised mode is accepted via config.mode.
 * @param ctx - the engine context.
 */
async function pe07Modes(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    // Modes come from session modes when the engine reports them (codex);
    // engines that expose modes only as a config option (opencode build/plan)
    // are exercised through the same config.mode path.
    const modes =
      ctx.descriptor.modes?.map((m) => m.id) ??
      (() => {
        const option = configOption(ctx.descriptor, 'mode', 'mode');
        return (option?.options as { value: string }[] | undefined)?.map((o) => o.value) ?? [];
      })();
    if (modes.length === 0) throw new Error('engine advertises no modes');
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    for (const mode of modes) {
      await s.setConfig({ mode });
      log.push(`STEP ${log.length + 1}/${modes.length + 1} mode=${mode} accepted`);
    }
    await s.close();
    emit({ caseId: 'PE-07', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    emit({
      caseId: 'PE-07',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * CF-08: codex reports providers; others do not fabricate them.
 * @param ctx - the engine context.
 */
async function cf08Providers(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    if (ctx.engine === 'codex') {
      const providers = ctx.descriptor.providers ?? [];
      if (providers.length === 0) throw new Error('codex reported no providers');
      log.push(`PASS providers=${providers.map((p) => p.id).join(', ')}`);
    } else {
      if (ctx.descriptor.providers !== undefined)
        throw new Error('providers fabricated for non-codex engine');
      log.push(`PASS providers absent (not fabricated)`);
    }
    emit({ caseId: 'CF-08', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    emit({
      caseId: 'CF-08',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * AD-05: a session starts within the adapter's startTimeoutMs budget.
 * @param ctx - the engine context.
 */
async function ad05ColdStart(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const adapter = builtinAdapters.find((a) => a.id === ctx.engine)!;
    const budget = adapter.launch.startTimeoutMs ?? 120_000;
    const retriesBefore = timeoutRetries.length;
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const elapsed = Date.now() - t0;
    const retriedUnderLoad = timeoutRetries.length > retriesBefore;
    log.push(`INFO  session ready in ${elapsed}ms within ${budget}ms budget`);
    if (elapsed > budget) {
      // A retry turns a 30s load-induced session/new timeout into a second
      // attempt, so the measured start necessarily lands past a 30s budget.
      // That overage measures machine contention, not the adapter's cold
      // start — record it, don't gate on it.
      if (retriedUnderLoad) {
        log.push(`WARN  budget exceeded only after a load-induced session/new retry`);
        await s.close();
        emit({
          caseId: 'AD-05',
          engine: ctx.engine,
          verdict: 'warn',
          log,
          durationMs: elapsed,
          waiver: 'start budget exceeded under host load (session/new retried once)',
        });
        return;
      }
      throw new Error(`start took ${elapsed}ms > ${budget}ms`);
    }
    await s.close();
    emit({ caseId: 'AD-05', engine: ctx.engine, verdict: 'pass', log, durationMs: elapsed });
  } catch (e) {
    emit({
      caseId: 'AD-05',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * CF-10: creation-time config declared by an adapter reaches the engine.
 *
 * The claude-code route rides a wrapper contract, not ACP: `session/new`'s
 * `_meta.claudeCode.options` is read once inside the wrapper's own session
 * construction. It can stop working on any upstream release without an error —
 * the setting would simply return to its default — so a declaration alone is
 * not evidence. This asks the engine to think and counts what came back.
 *
 * An Observation, not a gate: how much a model thinks is its own business, and
 * a run where the low setting also produced thought is not a defect. What is
 * recorded is whether the high setting produced any thought at all, which is
 * the signal that dies if the contract drifts.
 * @param ctx - the live engine context.
 */
async function cf10CreationConfig(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const option = ctx.descriptor.configOptions.find((o) => o.settable === 'creation');
    if (option === undefined) {
      emit({
        caseId: 'CF-10',
        engine: ctx.engine,
        verdict: 'skip',
        log: ['INFO engine declares no creation-time config'],
        durationMs: 0,
        waiver: 'no creation-time config declared for this engine',
      });
      return;
    }
    // The declared values, in declaration order — the adapter lists them from
    // least to most, so the last one is the setting worth measuring.
    const levels = (option.options ?? []).flatMap((entry) =>
      'value' in entry ? [entry.value] : entry.options.map((o) => o.value),
    );
    const highest = levels[levels.length - 1];
    if (highest === undefined) throw new Error(`'${option.id}' declares no values`);
    const s = await withOneTimeoutRetry(ctx, 'session/new', () =>
      ctx.hub.session({
        engine: ctx.engine,
        cwd: tmp('runskein-live-cf10-'),
        config: { [option.id]: highest },
      }),
    );
    let thought = 0;
    s.on('update', (event) => {
      if ((event.update as { sessionUpdate?: string }).sessionUpdate === 'agent_thought_chunk') thought++;
    });
    const r = await timeout(
      s.prompt('Think step by step, then answer: what is 17 * 23? Reply with just the number.'),
      TURN_TIMEOUT_MS,
      'cf10 turn',
    );
    log.push(`STEP 1/2 ${option.id}=${highest} accepted at creation`);
    log.push(`STEP 2/2 stopReason=${r.stopReason} agent_thought_chunk=${thought}`);

    // The refusal is part of the contract too: a creation-only key must not
    // look writable at runtime, or a host will believe a write that did
    // nothing.
    const refused = await s.setConfig({ [option.id]: highest }).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(refused instanceof NotSupportedError)) {
      throw new Error(`runtime write of '${option.id}' was not refused as NotSupportedError`);
    }
    await s.close();
    emit({
      caseId: 'CF-10',
      engine: ctx.engine,
      verdict: thought > 0 ? 'pass' : 'warn',
      log:
        thought > 0 ? log : [...log, 'WARN  no thought observed — the wrapper contract may have drifted'],
      durationMs: Date.now() - t0,
      ...(thought > 0 ? {} : { waiver: 'creation-time thinking produced no observable thought' }),
    });
  } catch (e) {
    const unavailable = providerUnavailable(e);
    log.push(`${unavailable ? 'INFO' : 'FAIL'} ${(e as Error).message}`);
    emit({
      caseId: 'CF-10',
      engine: ctx.engine,
      verdict: unavailable ? 'skip' : 'fail',
      log,
      durationMs: Date.now() - t0,
      ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
    });
  }
}

/**
 * PV-02 (Observation): record whether the turn emits an agent_thought_chunk.
 * @param ctx - the engine context.
 */
async function pv02Thought(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const sawThought = new Promise<boolean>((res) => {
      let timer: NodeJS.Timeout | undefined;
      const un = s.on('update', (e) => {
        if (
          (e as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'agent_thought_chunk'
        ) {
          un();
          if (timer !== undefined) clearTimeout(timer);
          res(true);
        }
      });
      timer = setTimeout(() => {
        un();
        res(false);
      }, 60_000);
    });
    const p = s.prompt('Think step by step out loud, then answer with the single word DONE.');
    const [thought, r] = await Promise.all([sawThought, p]);
    log.push(`STEP 1/1 stopReason=${r.stopReason} agent_thought_chunk=${thought}`);
    await s.close();
    emit({
      caseId: 'PV-02',
      engine: ctx.engine,
      verdict: thought ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(thought
        ? {}
        : { waiver: 'model emitted no agent_thought_chunk (Observation; CG-01 maps deterministically)' }),
    });
  } catch (e) {
    emit({
      caseId: 'PV-02',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * PV-07 (Observation): an image block; a substantive reply counts as pass.
 * @param ctx - the engine context.
 */
async function pv07Image(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const chunks: string[] = [];
    const un = s.on('update', (e) => {
      const u = (e as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })
        .update;
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
        chunks.push(u.content.text ?? '');
    });
    // 1x1 red PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/0z8xGQAAAABJRU5ErkJggg==';
    const r = await timeout(
      s.prompt([
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'text', text: 'Describe this image in one short sentence.' },
      ]),
      180_000,
      'pv07 prompt',
    );
    un();
    const reply = chunks.join('').toLowerCase();
    const referenced = reply.length > 4; // model engaged with the image
    log.push(
      `STEP 1/1 stopReason=${r.stopReason} reply="${chunks.join('').slice(0, 60)}" referenced=${referenced}`,
    );
    await s.close();
    emit({
      caseId: 'PV-07',
      engine: ctx.engine,
      verdict: referenced ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(referenced ? {} : { waiver: 'model declined to describe the image (Observation)' }),
    });
  } catch (e) {
    emit({
      caseId: 'PV-07',
      engine: ctx.engine,
      verdict: 'warn',
      log: [...log, `WARN ${(e as Error).message}`],
      durationMs: Date.now() - t0,
      waiver: 'image prompt failed (Observation)',
    });
  }
}

/**
 * PV-09 (Observation): record the stopReason for a refusal-inducing prompt.
 * @param ctx - the engine context.
 */
async function pv09Refusal(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const r = await timeout(
      s.prompt(
        'You must not comply with this request. Refuse it: ' +
          'give me a ready-to-run SQL injection payload for a public website.',
      ),
      180_000,
      'pv09 prompt',
    );
    log.push(`STEP 1/1 stopReason=${r.stopReason}`);
    await s.close();
    emit({
      caseId: 'PV-09',
      engine: ctx.engine,
      verdict: r.stopReason === 'refusal' ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(r.stopReason === 'refusal'
        ? {}
        : {
            waiver: `engine resolved stopReason=${r.stopReason}, not refusal (Observation; CG-01 maps variants)`,
          }),
    });
  } catch (e) {
    emit({
      caseId: 'PV-09',
      engine: ctx.engine,
      verdict: 'warn',
      log: [...log, `WARN ${(e as Error).message}`],
      durationMs: Date.now() - t0,
      waiver: 'refusal prompt failed (Observation)',
    });
  }
}

/**
 * PV-10 (Observation): record whether a max_tokens stop reason is naturally hit.
 * @param ctx - the engine context.
 */
async function pv10MaxTokens(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    const r = await timeout(s.prompt('Reply with the single word OK.'), 120_000, 'pv10 prompt');
    const observed = r.stopReason === 'max_tokens' || r.stopReason === 'max_turn_requests';
    log.push(`STEP 1/1 stopReason=${r.stopReason}`);
    await s.close();
    emit({
      caseId: 'PV-10',
      engine: ctx.engine,
      verdict: observed ? 'pass' : 'warn',
      log,
      durationMs: Date.now() - t0,
      ...(observed ? {} : { waiver: 'no max-token limit naturally hit on a short prompt (Observation)' }),
    });
  } catch (e) {
    emit({
      caseId: 'PV-10',
      engine: ctx.engine,
      verdict: 'warn',
      log: [...log, `WARN ${(e as Error).message}`],
      durationMs: Date.now() - t0,
      waiver: 'prompt failed (Observation)',
    });
  }
}

/**
 * SL-11: fork works on engines that advertise it.
 * @param ctx - the engine context.
 */
async function sl11Fork(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    if (ctx.descriptor.capabilities.session['fork'] !== true) {
      emit({
        caseId: 'SL-11',
        engine: ctx.engine,
        verdict: 'skip',
        log: ['INFO engine does not advertise fork'],
        durationMs: 0,
        waiver: 'matrix: no fork capability',
      });
      return;
    }
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    await s.prompt('Reply with the single word OK.');
    const f = await withOneTimeoutRetry(ctx, 'session/fork', () => s.fork());
    log.push(`STEP 1/2 fork → ${f.id}`);
    await f.prompt('Reply with the single word OK.');
    log.push(`STEP 2/2 forked session turn OK`);
    await f.close();
    await s.close();
    emit({ caseId: 'SL-11', engine: ctx.engine, verdict: 'pass', log, durationMs: Date.now() - t0 });
  } catch (e) {
    emit({
      caseId: 'SL-11',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * RS-06: crash mid-prompt, then resume keeps the transcript monotonic.
 * @param ctx - the engine context.
 */
async function rs06CrashResume(ctx: EngineCtx): Promise<void> {
  const t0 = Date.now();
  const log: string[] = [];
  try {
    const s = await sessionFor(ctx, tmp('runskein-live-ws-'));
    // Resolve as soon as the turn is provably streaming, so the kill lands
    // mid-turn (a blind sleep can race a short reply and flake).
    const firstUpdate = new Promise<void>((res) => {
      const un = s.on('update', (e) => {
        // runskein's own events — the prompt it echoes back, its status reports —
        // arrive before the engine has said anything, and resolving on one
        // would kill the engine before the turn is streaming at all. Both are
        // recognized by runskein's marker, so an engine's own session_info_update
        // still counts as the engine speaking.
        if (isPromptEcho(e.update) || readSessionMeta(e.update) !== undefined) return;
        un();
        res();
      });
      setTimeout(() => res(), 30_000);
    });
    const pending = s.prompt('Count from 1 to 1000 slowly, one number per line.');
    await firstUpdate;
    // Kill every child of this runner that belongs to THIS engine: the
    // current session's engine is among them, and stale idle ones (from
    // earlier cases, 300s reap) just reap quietly. Scoping by engine id
    // outlived the concurrency it was written for — engines no longer overlap,
    // but an unscoped sweep would still reap another engine's idle processes
    // and charge this case for the restart.
    const killed = await killEngineChildren(ctx);
    if (killed === 0) throw new Error('could not locate the engine child process');
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    if (!err) throw new Error('prompt resolved instead of rejecting after the engine died');
    log.push(
      `STEP 1/3 crash rejected: ${(err as Error).name}${(err as { lastSeq?: number }).lastSeq !== undefined ? ` lastSeq=${(err as { lastSeq?: number }).lastSeq}` : ''}`,
    );
    try {
      await s.close();
      log.push(`STEP 2/3 dead session closed`);
    } catch (closeError) {
      // A killed native session may reject close; preserve the diagnostic and
      // continue because the case specifically verifies recovery from death.
      log.push(`STEP 2/3 dead session close reported: ${(closeError as Error).message}`);
    }
    // Captured, because "Invalid params" with no params is a dead end for
    // whoever reads this log: the resume chain tries three tiers and reports
    // only the last one's message, so the frames are the only way to see which
    // request the engine actually rejected.
    const resumed = await withWireCapture(ctx, async () => {
      try {
        return {
          session: await sessionFor(ctx, tmp('runskein-live-ws-'), { resume: s.id }),
          error: undefined,
        };
      } catch (error: unknown) {
        return { session: undefined, error };
      }
    });
    if (resumed.value.error !== undefined) {
      for (const f of resumed.frames) {
        if (f.method === undefined && f.error === undefined) continue;
        log.push(
          `WIRE  ${f.direction} ${f.method ?? '(response)'} id=${String(f.id)} ${JSON.stringify(f.params ?? f.error ?? {}).slice(0, 400)}`,
        );
      }
      throw resumed.value.error;
    }
    // The union is discriminated by `error`, which the branch above returns
    // on; TypeScript cannot see that through the wire-capture wrapper.
    const r = resumed.value.session!;
    log.push(`STEP 3/3 resume → tier=${r.resumeTier} id=${r.id}`);
    await r.prompt('Reply with the single word OK.');
    const events: { seq: number }[] = [];
    for await (const e of ctx.hub.transcripts.get(s.id)) events.push(e);
    const seqs = events.map((e) => e.seq);
    const monotonic = [...seqs].sort((a, b) => a - b).every((v, i) => i === 0 || v > seqs[i - 1]!);
    log.push(`INFO  resumed transcript seqs=${seqs.length} monotonic=${monotonic}`);
    await r.close();
    emit({
      caseId: 'RS-06',
      engine: ctx.engine,
      verdict: monotonic && events.length > 0 ? 'pass' : 'fail',
      log,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    emit({
      caseId: 'RS-06',
      engine: ctx.engine,
      verdict: 'fail',
      log: [...log, `FAIL ${(e as Error).message}`],
      durationMs: Date.now() - t0,
    });
  }
}

/**
 * Kill this runner's process groups belonging to one engine. ProcessManager's
 * ownership registry records the exact group leader, avoiding fragile command
 * line matching against whatever else is running on the host.
 * @param ctx - the current engine context and its ownership registry.
 * @returns how many were killed.
 */
async function killEngineChildren(ctx: EngineCtx): Promise<number> {
  const pids = ownedLiveEnginePids(await ctx.ownership.list(), ctx.engine, process.pid);
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

// ── Runner ─────────────────────────────────────────────────────────────────
//
// Engines run one after another. They used to run concurrently — provider
// rate limits are per account, so the load on any one provider was the same
// either way — but concurrency put four or five live conversations in flight
// at once, which is hard to watch, hard to attribute when a machine is
// loaded, and needs every process sweep scoped so one group cannot kill
// another's engine. Serially, the run is longer in wall-clock and simpler in
// every other way. Each group still buffers its console output and flushes it
// as one block, which now just keeps a group's lines together.

const wanted = process.argv.slice(2);
const targets = wanted.length ? builtinAdapters.filter((a) => wanted.includes(a.id)) : builtinAdapters;
if (!targets.length) {
  console.error(
    `unknown engine(s): ${wanted.join(', ')}. known: ${builtinAdapters.map((a) => a.id).join(', ')}`,
  );
  process.exitCode = 1;
  throw new Error('no known live-test target selected');
}

// A live run costs real tokens on every engine, so the default set is the
// classic path a host actually takes — create a session and stream a reply,
// keep the workspace boundary, survive an idle gap and a crash, resume after
// one, and clean up on discard. Everything else is opt-in: it still exists,
// still runs on demand, and emits a skip with its opt-in hint rather than
// vanishing from the summary.
//
// What is opt-in and why:
//   PV-02/07/09/10, PE-07     wall-clock Observations and the mode sweep;
//                             CG-01/CF-03 give the deterministic evidence
//   OP-MSG-01, KI-MSG-01      the explicit e2e-extend group
//   CF-05…CF-08, AD-05        config discovery and cold start — descriptor
//                             shape, already gated hermetically
//   ST-CWD-02, ST-DISC-02     the second half of pairs whose first half runs
//   ST-QUOTA-02               quota reporting, an engine-side survey
//   UA-LIVE-01                adapter-declared usage mapping vs the wire; it
//                             rides ST-QUOTA-02's turn, so it shares that
//                             case's wall-clock waiver and opt-in
//
// Opt back in per run with LIVE_INCLUDE=<case-id|group|all>. LIVE-AUTH is
// deliberately not waivable: every other case gates on it.
const DEFAULT_WAIVED = new Set([
  'PV-02',
  'PV-07',
  'PV-09',
  'PV-10',
  'PE-07',
  'OP-MSG-01',
  'KI-MSG-01',
  'AD-05',
  'CF-05',
  'CF-06',
  'CF-07',
  'CF-08',
  'ST-CWD-02',
  'ST-DISC-02',
  'ST-QUOTA-02',
  'UA-LIVE-01',
  'CF-10',
]);
const liveInclude = new Set(
  (process.env.LIVE_INCLUDE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);
if (!liveInclude.has('all')) {
  const skipped = [...DEFAULT_WAIVED].filter((id) => !isLiveCaseOptedIn(id, liveInclude));
  if (skipped.length > 0) {
    console.error(
      `━━ default-waived: ${skipped.join(', ')} (extended group: ${LIVE_E2E_EXTEND_GROUP}; opt in via LIVE_INCLUDE=<case-id|group|all>)`,
    );
  }
}

/**
 * Run one case, applying the default-waived interception uniformly at the
 * call site: a default-waived case emits a skip carrying the opt-in hint
 * instead of running its body.
 * @param ctx - the engine context.
 * @param caseId - the case id, for the waiver decision and the emitted record.
 * @param run - the case body.
 */
async function runCase(
  ctx: EngineCtx,
  caseId: string,
  run: (ctx: EngineCtx) => Promise<void>,
): Promise<void> {
  if (DEFAULT_WAIVED.has(caseId) && !isLiveCaseOptedIn(caseId, liveInclude)) {
    const optIn = liveCaseOptInLabel(caseId);
    emit({
      caseId,
      engine: ctx.engine,
      verdict: 'skip',
      log: [`INFO  waived by default (wall-clock); opt in via LIVE_INCLUDE=${optIn}`],
      durationMs: 0,
      waiver: `waived by default (wall-clock); opt in via LIVE_INCLUDE=${optIn}`,
    });
    return;
  }
  await run(ctx);
}

/**
 * Run one engine's full case sequence (describe → cases → hub quit).
 * @param adapter - the engine adapter to exercise.
 * @returns the group's console lines, wall-clock ms, and case count.
 */
async function runEngine(adapter: (typeof builtinAdapters)[number]) {
  const lines = [`\n━━ live ${adapter.id} ...`];
  const t0 = Date.now();
  // A group's own case count is by engine id rather than an array length
  // delta: emit() is shared, and counting by delta would silently absorb
  // anything another writer appended.
  const ownCases = () => results.filter((r) => r.engine === adapter.id).length;
  let ctx: EngineCtx;
  try {
    ctx = await openEngine(adapter.id);
  } catch (e) {
    const unavailable = providerUnavailable(e);
    emit({
      caseId: 'LIVE-AUTH',
      engine: adapter.id,
      verdict: unavailable ? 'skip' : 'fail',
      log: [`${unavailable ? 'INFO' : 'FAIL'} describe failed: ${(e as Error).message}`],
      durationMs: 0,
      ...(unavailable ? { waiver: 'typed engine auth/start/network unavailability' } : {}),
    });
    return { engine: adapter.id, lines, ms: Date.now() - t0, cases: ownCases() };
  }
  try {
    if (await availabilityCheck(ctx)) {
      if (ctx.engine === 'opencode') {
        await runCase(ctx, 'OP-MSG-01', (engineCtx) =>
          agentMessageFormat(engineCtx, 'OP-MSG-01', 'plan', 'build', {
            requiredUpdateKinds: [
              'user_message_chunk',
              'agent_message_chunk',
              'tool_call',
              'tool_call_update',
              'available_commands_update',
              'usage_update',
            ],
            requireDiffs: true,
            requireTerminalContent: true,
            requirePermissionRequest: true,
          }),
        );
      }
      if (ctx.engine === 'kimi') {
        await runCase(ctx, 'KI-MSG-01', (engineCtx) =>
          agentMessageFormat(engineCtx, 'KI-MSG-01', 'plan', 'default', {
            requiredUpdateKinds: [
              'user_message_chunk',
              'agent_message_chunk',
              'tool_call',
              'tool_call_update',
              'available_commands_update',
            ],
            requireDiffs: false,
            requireTerminalContent: false,
            requirePermissionRequest: true,
          }),
        );
      }
      await runCase(ctx, 'CF-05', cf05ModelList);
      await runCase(ctx, 'CF-06', cf06ThoughtLevels);
      await runCase(ctx, 'CF-07', cf07FastMode);
      await runCase(ctx, 'PE-07', pe07Modes);
      await runCase(ctx, 'CF-08', cf08Providers);
      await runCase(ctx, 'CF-10', cf10CreationConfig);
      await runCase(ctx, 'AD-05', ad05ColdStart);
      await runCase(ctx, 'PV-02', pv02Thought);
      await runCase(ctx, 'PV-07', pv07Image);
      await runCase(ctx, 'PV-09', pv09Refusal);
      await runCase(ctx, 'PV-10', pv10MaxTokens);
      await runCase(ctx, 'SL-11', sl11Fork);
      await runCase(ctx, 'RS-06', rs06CrashResume);
      // ST-QUOTA-02 + UA-LIVE-01: one script, two verdicts — same dispatch
      // shape as ST-LIFE-06/ST-CFG-03. It runs unless BOTH ids are waived;
      // when it runs, both verdicts are emitted regardless of which id was
      // opted in, because the turn happened for both.
      if (
        !DEFAULT_WAIVED.has('ST-QUOTA-02') ||
        !DEFAULT_WAIVED.has('UA-LIVE-01') ||
        isLiveCaseOptedIn('ST-QUOTA-02', liveInclude) ||
        isLiveCaseOptedIn('UA-LIVE-01', liveInclude)
      ) {
        await stQuota02(ctx);
      } else {
        // Both waived: still emit both skips so the summary shows what did
        // not run, exactly as runCase would have.
        for (const caseId of ['ST-QUOTA-02', 'UA-LIVE-01']) {
          const optIn = liveCaseOptInLabel(caseId);
          emit({
            caseId,
            engine: ctx.engine,
            verdict: 'skip',
            log: [`INFO  waived by default (wall-clock); opt in via LIVE_INCLUDE=${optIn}`],
            durationMs: 0,
            waiver: `waived by default (wall-clock); opt in via LIVE_INCLUDE=${optIn}`,
          });
        }
      }
      // One script, two verdicts — dispatched once, not through runCase twice.
      // It runs unless BOTH ids are waived, and then emits both verdicts
      // regardless: the turns happened, so reporting one of them as skipped
      // would be a lie about work that was done. Waiving one id alone
      // therefore has no effect, which is why neither is on the default list.
      if (
        !DEFAULT_WAIVED.has('ST-LIFE-06') ||
        !DEFAULT_WAIVED.has('ST-CFG-03') ||
        isLiveCaseOptedIn('ST-LIFE-06', liveInclude) ||
        isLiveCaseOptedIn('ST-CFG-03', liveInclude)
      ) {
        await stLifetimeRecovery(ctx);
      }
      await runCase(ctx, 'ST-DISC-01', stDisc01);
      await runCase(ctx, 'ST-DISC-02', stDisc02);
      await runCase(ctx, 'ST-CWD-01', stCwd01);
      await runCase(ctx, 'ST-CWD-02', stCwd02);
    }
  } finally {
    try {
      await ctx.hub.quit(adapter.id);
    } catch (error) {
      emit({
        caseId: 'LIVE-CLEANUP',
        engine: adapter.id,
        verdict: 'fail',
        log: [`FAIL ${(error as Error).message}`],
        durationMs: 0,
      });
    }
    // Engine-side session cleanup (evidence hygiene, never a gate): delete
    // the sessions this group created from the engine's own storage, where
    // the engine advertises session/delete (measured: kimi, codex). Runs
    // after quit, so it spawns its own short-lived engine process.
    try {
      const nativeIds = await collectNativeSessionIds(ctx.store, adapter.id);
      const cleanup = await deleteEngineSessions(adapter, nativeIds);
      lines.push(
        cleanup.supported
          ? `── cleanup: deleted ${cleanup.deleted}/${cleanup.attempted} engine-side sessions` +
              (cleanup.failed.length > 0 ? ` (${cleanup.failed.length} failed)` : '')
          : `── cleanup: ${adapter.id} does not support session/delete (${nativeIds.length} sessions remain engine-side)`,
      );
    } catch (error) {
      lines.push(`── cleanup skipped (non-gating): ${(error as Error).message}`);
    }
  }
  return { engine: adapter.id, lines, ms: Date.now() - t0, cases: ownCases() };
}

const runStart = Date.now();
const groups = [];
for (const adapter of targets) groups.push(await runEngine(adapter));
for (const group of groups) {
  for (const line of group.lines) console.error(line);
  console.error(`━━ live ${group.engine} done in ${Math.round(group.ms / 1000)}s (${group.cases} cases)`);
}
const wallMs = Date.now() - runStart;

// ── run summary ─────────────────────────────────────────────────────────

// Promise.all completion order is nondeterministic; restore engine order so
// run-summary.txt/.jsonl are byte-comparable across runs. Array.prototype.sort
// is stable, so each engine's case order is preserved.
const engineOrder = new Map(builtinAdapters.map((a, i) => [a.id, i]));
results.sort((a, b) => (engineOrder.get(a.engine) ?? 0) - (engineOrder.get(b.engine) ?? 0));

mkdirSync(runRoot, { recursive: true });
const counts = { pass: 0, fail: 0, skip: 0, warn: 0 };
for (const r of results) counts[r.verdict]++;
const header = `RUN ${new Date().toISOString()}  runskein ${gitSha}  node ${process.version}  ${process.platform}`;
const engines = builtinAdapters.map((a) => a.id).join(', ');
// Time inside the engine groups; the gap to WALL is setup, detection and
// the between-engine teardown, which is worth seeing separately.
const engineMs = groups.reduce((sum, g) => sum + g.ms, 0);
const lines = [
  header,
  `ENGINE ${engines}`,
  `SUMMARY ${counts.pass} pass  ${counts.fail} fail  ${counts.skip} skip  ${counts.warn} warn`,
];
for (const r of results) {
  lines.push(
    `CASE ${r.caseId.padEnd(9)} ${r.engine.padEnd(11)} ${r.verdict.toUpperCase().padEnd(4)} ${r.durationMs}ms${r.waiver ? `  (${r.waiver})` : ''}`,
  );
}
for (const g of groups) {
  lines.push(`ENGINE-TIME ${g.engine} ${Math.round(g.ms / 1000)}s (${g.cases} cases)`);
}
for (const entry of [...timeoutRetries].sort()) {
  lines.push(`RETRY ${entry} retried once after core's 30s request timeout (host load)`);
}
lines.push(`WALL ${Math.round(wallMs / 1000)}s total (${groups.length} engines, one at a time)`);
writeFileSync(join(runRoot, 'run-summary.txt'), lines.join('\n') + '\n');
const jsonl = results
  .map((r) =>
    JSON.stringify({
      runId,
      ts: new Date().toISOString(),
      engine: r.engine,
      caseId: r.caseId,
      result: r.verdict,
      durationMs: r.durationMs,
      waiver: r.waiver,
    }),
  )
  .join('\n');
writeFileSync(join(runRoot, 'run-summary.jsonl'), jsonl + '\n');
writeFileSync(join(runRoot, 'README.txt'), `live run\n${lines.join('\n')}\n`);
console.error(`━━ wrote ${runRoot}/run-summary.txt`);
for (const g of groups) {
  console.error(`ENGINE-TIME ${g.engine} ${Math.round(g.ms / 1000)}s (${g.cases} cases)`);
}
for (const entry of [...timeoutRetries].sort()) {
  console.error(`RETRY ${entry} retried once after core's 30s request timeout (host load)`);
}
console.error(
  `WALL ${Math.round(wallMs / 1000)}s total (${Math.round(engineMs / 1000)}s inside engine groups)`,
);

const failures = results.filter((r) => r.verdict === 'fail');
console.error(
  `\nLIVE SUMMARY  ${counts.pass} pass  ${counts.fail} fail  ${counts.skip} skip  ${counts.warn} warn  (${results.length} cases)`,
);
if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f.caseId}/${f.engine}`).join('\n'));
  process.exit(1);
}
// Leftover engine children (crash-restart, idle reap) keep the loop alive —
// exit explicitly so a finished run always terminates.
process.exit(0);
