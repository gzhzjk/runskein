/**
 * Live-engine smoke layer: drives the CLI binary against one real engine, the
 * way a person drives it.
 *
 * It used to run a turn on every engine plus per-engine cancel, fork, resume,
 * config-error and describe cases. Each of those has a hermetic twin by case
 * id — the mock suites cover CH-01…16 and DE-01…07 in full — and the
 * engine-side half of each is now asserted across every engine elsewhere: the
 * Core gate runs prompt, cancel and the permission round-trip per engine, and
 * the conformance live runner covers resume (RS-06) and fork (SL-11). Proving
 * the same behaviour a second time here cost real tokens and answered nothing
 * the other two had not.
 *
 * What is left is the claim only this suite can make: the binary works — the
 * REPL loop runs, real descriptor data reaches the renderer, a real turn
 * completes and the process exits clean. One engine settles that; four settle
 * it four times. The engine is the first built-in detection reports as
 * installed and not unauthenticated.
 *
 * LV-01 stays as it was: every built-in engine must appear in the detect
 * table, which is about detection rather than about conversation and costs
 * nothing.
 *
 * Every case checks its engine precondition (binary + auth from `engines`
 * detect output) and prints a structured waiver — never silently skips:
 *   SKIP <case> waiver=environment reason=...
 *   SKIP <case> waiver=behaviour  reason=...   (engine chose not to exercise
 *                                               the path — not a CLI failure)
 *
 * Prompts are intentionally cheap. Each case is capped at 120s.
 *
 * Run: pnpm --filter @runskein/cli test:live
 */
import { join } from 'node:path';
import {
  collectNativeSessionIds,
  deleteEngineSessions,
  isLiveEnvironmentErrorLine,
  liveConfigFor,
  livePinRejectionReason,
} from '@runskein/conformance/live-support';
import { jsonlStore } from '@runskein/core';
import claudeCode from '@runskein/adapter-claude-code';
import codex from '@runskein/adapter-codex';
import pi from '@runskein/adapter-pi';
import kimi from '@runskein/adapter-kimi';
import opencode from '@runskein/adapter-opencode';
import { ChatDriver, runCli, scratch } from './helpers.js';

/** Every chat cwd this run created — each holds a `.transcripts` store that
 * inventories the engine-side sessions the CLI created there (cleanup). */
const chatCwds: string[] = [];

/** scratch() for chat cwds, recorded for end-of-run engine-side cleanup. */
function chatScratch(): string {
  const dir = scratch('runskein-cli-live-cwd-');
  chatCwds.push(dir);
  return dir;
}

const TURN_TIMEOUT_MS = 110_000;
const BUILTIN_IDS = ['opencode', 'kimi', 'claude-code', 'codex', 'pi'];

interface EngineRow {
  installed: boolean;
  version: string;
  auth: string;
}

// ── result recording (buffered per engine group) ───────────────────────────

let passes = 0;
let failures = 0;
let skips = 0;

/** One engine group's buffered output and timing. */
interface Group {
  engine: string;
  lines: string[];
  cases: number;
  ms: number;
}

function newGroup(engine: string): Group {
  return { engine, lines: [], cases: 0, ms: 0 };
}

function check(g: Group, name: string, cond: boolean, detail?: string): void {
  g.cases++;
  if (cond) {
    passes++;
    g.lines.push(`ok   ${name}`);
  } else {
    failures++;
    g.lines.push(
      `FAIL ${name}${detail !== undefined ? `\n----- detail -----\n${detail}\n------------------` : ''}`,
    );
  }
}

function waive(
  g: Group,
  caseId: string,
  reason: string,
  kind: 'environment' | 'behaviour' = 'environment',
): void {
  skips++;
  g.cases++;
  g.lines.push(`SKIP ${caseId} waiver=${kind} reason=${reason}`);
}

/** Print a group's buffered lines as one uninterleaved block. */
function flush(g: Group): void {
  console.log(`\n━━ group ${g.engine} ${Math.round(g.ms / 1000)}s (${g.cases} cases)`);
  for (const line of g.lines) console.log(line);
}

/** Parse the `engines` table: id → row fields. */
function detectEngines(): Map<string, EngineRow> {
  const r = runCli(['engines'], undefined, { timeoutMs: 60_000 });
  const rows = new Map<string, EngineRow>();
  for (const line of r.stdout.split('\n')) {
    const id = BUILTIN_IDS.find((b) => line.startsWith(`${b} `));
    if (!id) continue;
    const cols = line.trim().split(/\s{2,}/);
    rows.set(id, {
      installed: cols[1] === 'yes',
      version: cols[2] ?? '-',
      auth: cols[3] ?? '-',
    });
  }
  return rows;
}

/** Engine usable for live cases: binary present and not known-unauthenticated. */
function usable(rows: Map<string, EngineRow>, id: string): string | undefined {
  const row = rows.get(id);
  if (!row) return `engine ${id} missing from engines table`;
  if (!row.installed) return `engine ${id} not installed`;
  if (row.auth === 'no') return `engine ${id} unauthenticated`;
  return undefined;
}

/**
 * Live runs force the config each engine's adapter pins in its
 * live.config.json, keeping turns cheap and comparable across machines.
 *
 * One mechanism for every engine: `-c key=value`, which lands on
 * SessionOpts.config and is written with the engine's own config surface.
 * claude-code previously needed an environment pin here because core had no
 * model path for it; that pin was measured to have no effect, and the engine
 * now takes `-c model=…` like the others.
 */
const FORCED_CONFIG: Record<string, string[]> = {};
for (const engine of BUILTIN_IDS) {
  const config = liveConfigFor(engine).config;
  if (config !== undefined) {
    FORCED_CONFIG[engine] = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  }
}

function liveChat(engine: string, extra: string[] = []): ChatDriver {
  return new ChatDriver(engine, {
    chatCwd: chatScratch(),
    extra: [...(FORCED_CONFIG[engine] ?? []), ...extra],
  });
}

/** Wait for either of two markers; returns the one that appeared first. */
async function waitForEither(chat: ChatDriver, a: string, b: string, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    if (chat.combined.includes(a)) return a;
    if (chat.combined.includes(b)) return b;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for ${JSON.stringify(a)} or ${JSON.stringify(b)}\n${chat.combined}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** First `[error] …` line of the combined output, if any. */
function firstErrorLine(chat: ChatDriver): string | undefined {
  return chat.combined.split('\n').find((l) => l.startsWith('[error]'));
}

/**
 * Thrown by `waitForSessionRetrying` when session creation failed for an
 * environmental reason (auth/network/quota — see `isLiveEnvironmentErrorLine`)
 * rather than a CLI defect. Call sites catch this separately and `waive()`
 * instead of failing — e.g. an engine whose `detect()` never probes real
 * auth (codex, opencode) reports installed-and-unknown, so the first real
 * signal that credentials are missing is `session/new` itself blowing up.
 */
class LiveSessionEnvironmentError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * Classify a session-creation failure: environmental waiver or rethrow as-is.
 * A ConfigError line here is the engine declining the `-c` pin this suite
 * forced — waived with the pin's remediation, but only at this creation point;
 * a ConfigError surfacing anywhere else (e.g. mid-turn) is a real failure.
 * @param engine - the engine id, used to name the declined pin on a waiver.
 * @param chat - the chat process whose output carries the failure.
 * @param e - the failure thrown while waiting for the session banner.
 * @returns a LiveSessionEnvironmentError to throw on an environmental failure,
 *   or `e` unchanged.
 */
function classifySessionFailure(engine: string, chat: ChatDriver, e: unknown): unknown {
  const line = firstErrorLine(chat);
  if (line !== undefined && /^\[error\] ConfigError: /.test(line)) {
    return new LiveSessionEnvironmentError(
      `${livePinRejectionReason(engine, liveConfigFor(engine))} — ${line}`,
    );
  }
  return isLiveEnvironmentErrorLine(line) ? new LiveSessionEnvironmentError(line as string) : e;
}

/**
 * Wait for the session banner, retrying the whole chat process exactly once
 * when the failure is core's 30s `session/new` request timeout — the same
 * host-load artifact conformance/src/live.ts's `withOneTimeoutRetry` papers
 * over. Rarer now that engine groups run one at a time, but a cold start on a
 * busy machine can still cross the budget, and that is harness-inflicted load
 * rather than an engine signal.
 * A failure that instead carries an environmental `[error]` line (missing
 * auth, network, quota) throws `LiveSessionEnvironmentError` for the caller
 * to waive. Any other failure (a real hang, a genuine defect) propagates
 * unchanged.
 * @param engine - the engine id, used to name the declined pin on a waiver.
 * @param chat - the chat process already spawned.
 * @param recreate - spawns a fresh chat process for the retry.
 * @returns the chat process the session banner was actually seen on.
 */
async function waitForSessionRetrying<T extends ChatDriver>(
  engine: string,
  chat: T,
  recreate: () => T,
): Promise<T> {
  try {
    await chat.waitFor('[session] id=', 60_000);
    return chat;
  } catch (e) {
    const isSessionNewTimeout =
      chat.combined.includes("operation 'session/new' failed") &&
      chat.combined.includes('timeout after 30000ms');
    if (!isSessionNewTimeout) throw classifySessionFailure(engine, chat, e);
    chat.signal('SIGKILL');
    await chat.exit();
    const retry = recreate();
    try {
      await retry.waitFor('[session] id=', 60_000);
      return retry;
    } catch (e2) {
      throw classifySessionFailure(engine, retry, e2);
    }
  }
}

// ── cases (each runs inside its engine's group) ────────────────────────────

/**
 * LV-02 live: `describe` renders whatever a real engine actually reports.
 *
 * There used to be one of these per engine, asserting kimi's model row,
 * claude-code's models section and codex's providers section. What each
 * engine reports is measured by `pnpm probe` across all five and recorded in
 * the matrix; how the CLI lays it out is DE-01…DE-07, hermetically. Neither
 * needs a real engine per case.
 *
 * What no mock can supply is the shape of real descriptor data — a model list
 * with unexpected ids, a providers block an engine only fills in when it is
 * authenticated — reaching the renderer at all. One engine proves that; four
 * prove it four times.
 * @param g - the engine group.
 * @param rows - the detected engines table.
 * @param id - the engine to describe.
 */
async function lv02Describe(g: Group, rows: Map<string, EngineRow>, id: string): Promise<void> {
  const blocked = usable(rows, id);
  if (blocked !== undefined) {
    waive(g, `LV-02/${id}`, blocked);
    return;
  }
  const r = runCli(['describe', id], undefined, { timeoutMs: 120_000 });
  check(
    g,
    `LV-02/${id} describe renders a probed descriptor (DE-01 live)`,
    r.status === 0 && r.stdout.includes('source: probe'),
    `status=${r.status}\n${r.stdout}\n${r.stderr}`,
  );
}

/** LV-03 + CH-01 live: one real turn on the group's engine. */
async function lv03(g: Group, rows: Map<string, EngineRow>, id: string): Promise<void> {
  const blocked = usable(rows, id);
  if (blocked !== undefined) {
    waive(g, `LV-03/${id}`, blocked);
    return;
  }
  let chat = liveChat(id);
  try {
    chat = await waitForSessionRetrying(id, chat, () => liveChat(id));
    chat.write('Reply with the single word OK');
    const seen = await waitForEither(chat, '[turn] stopReason=', '[error]', TURN_TIMEOUT_MS);
    if (seen === '[error]') {
      const line = firstErrorLine(chat);
      // Shared waiver rule: an environmental failure (auth/quota/network)
      // the CLI surfaced correctly waives; any other typed error or an
      // `unexpected:` line is a real failure.
      if (isLiveEnvironmentErrorLine(line)) {
        waive(g, `LV-03/${id}`, `environmental engine failure surfaced cleanly: ${line}`);
        chat.write(':quit');
        await chat.exit(30_000);
        return;
      }
    }
    const sane = /\[turn\] stopReason=\S+ durationMs=\d+/.test(chat.combined);
    chat.write(':quit');
    const code = await chat.exit(30_000);
    check(
      g,
      `LV-03/${id} one real turn completes, exit 0 (CH-01 live)`,
      sane && code === 0,
      `code=${code}\n${chat.combined}`,
    );
  } catch (e) {
    if (e instanceof LiveSessionEnvironmentError) {
      waive(g, `LV-03/${id}`, `environmental failure creating the session: ${e.message}`);
    } else {
      check(g, `LV-03/${id} real turn`, false, String(e));
    }
    chat.signal('SIGKILL');
    await chat.exit();
  }
}

// ── suite ──────────────────────────────────────────────────────────────────

async function liveSuite(): Promise<void> {
  // Detect phase: the smoke case gates on this table, and LV-01 reads it as
  // its own assertion — the engines command against real detect.
  const rows = detectEngines();
  const pre = newGroup('detect');
  check(
    pre,
    `LV-01 engines runs against real detect (exit 0, ${BUILTIN_IDS.length} rows)`,
    rows.size === BUILTIN_IDS.length,
    [...rows.entries()].map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n'),
  );
  for (const id of BUILTIN_IDS) {
    const blocked = usable(rows, id);
    if (blocked !== undefined) {
      waive(pre, `LV-01/${id}`, blocked);
      continue;
    }
    const row = rows.get(id)!;
    check(pre, `LV-01/${id} installed with a detected version`, row.version !== '-', JSON.stringify(row));
  }
  flush(pre);

  // One engine, two cases. This suite used to run a turn on every engine plus
  // per-engine cancel, fork, resume, config-error and describe cases — every
  // one of which has a hermetic twin by case id (CH-01…16, DE-01…07 are all
  // covered by the mock suites), and whose engine-side half is now asserted
  // across every engine by the Core gate (prompt, cancel, permission) and the
  // conformance live runner (RS-06 resume, SL-11 fork). Running them here too
  // proved the same behaviour a second time, on real tokens.
  //
  // What is left is what only this suite can say: the CLI binary, driven the
  // way a person drives it, works against a real engine. That is a smoke test,
  // and one engine settles it.
  const smokeEngine = BUILTIN_IDS.find((id) => usable(rows, id) === undefined) ?? BUILTIN_IDS[0]!;
  const suites: Array<[string, Array<(g: Group) => Promise<void>>]> = [
    [smokeEngine, [(g) => lv02Describe(g, rows, smokeEngine), (g) => lv03(g, rows, smokeEngine)]],
  ];

  const runStart = Date.now();
  const groups = [];
  for (const [id, cases] of suites) {
    const g = newGroup(id);
    const t0 = Date.now();
    for (const runCase of cases) await runCase(g);
    g.ms = Date.now() - t0;
    flush(g);
    groups.push(g);
  }
  const wallMs = Date.now() - runStart;

  // One group today; the loop and the per-group line stay because the smoke
  // engine is chosen at runtime and a second one is a one-line change.
  const engineMs = groups.reduce((sum, g) => sum + g.ms, 0);
  for (const g of groups) {
    console.log(`ENGINE-TIME ${g.engine} ${Math.round(g.ms / 1000)}s (${g.cases} cases)`);
  }
  console.log(
    `WALL ${Math.round(wallMs / 1000)}s total (${groups.length} engine group(s); ${Math.round(engineMs / 1000)}s inside them)`,
  );
  console.log(skips > 0 ? `\n${skips} case(s) waived (see SKIP lines)` : '\nno waivers');
}

/**
 * Engine-side session cleanup (evidence hygiene, never a gate): every chat
 * cwd holds a `.transcripts` store; fold them into per-engine native-id
 * inventories and delete where the engine supports session/delete
 * (measured: kimi, codex — see docs/todo.md item 10).
 */
async function cleanupEngineSessions(): Promise<void> {
  for (const adapter of [opencode, kimi, claudeCode, codex, pi]) {
    try {
      const ids = new Set<string>();
      for (const cwd of chatCwds) {
        const store = jsonlStore(join(cwd, '.transcripts'));
        for (const id of await collectNativeSessionIds(store, adapter.id)) ids.add(id);
      }
      if (ids.size === 0) continue;
      const cleanup = await deleteEngineSessions(adapter, [...ids]);
      console.log(
        cleanup.supported
          ? `CLEANUP ${adapter.id}: deleted ${cleanup.deleted}/${cleanup.attempted} engine-side sessions` +
              (cleanup.failed.length > 0 ? ` (${cleanup.failed.length} failed)` : '')
          : `CLEANUP ${adapter.id}: session/delete unsupported (${ids.size} sessions remain engine-side)`,
      );
    } catch (e) {
      console.log(`CLEANUP ${adapter.id} skipped (non-gating): ${String(e)}`);
    }
  }
}

await liveSuite();
await cleanupEngineSessions();
console.log(
  failures === 0 ? `\nall ${passes} checks passed` : `\n${failures} check(s) FAILED (${passes} passed)`,
);
process.exit(failures === 0 ? 0 : 1);
