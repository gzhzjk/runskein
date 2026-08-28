/**
 * ST-CONC-01 — concurrency measurement (AC-3.1).
 *
 * The blind spot it closes: engine processes are shared by refcount, yet
 * concurrent turns on one process have never been measured. Whether a
 * runskein-side queue is the right answer to load (§2.3.3) depends entirely on
 * what the engines already do — a queue in front of an engine that already
 * serializes is a second queue, and the honest fix would be a configurable
 * timeout instead.
 *
 * Per engine: three sessions on ONE process, then three prompts fired
 * concurrently, each carrying its own codeword. Recorded per engine:
 *   - parallel / serialized / error, decided by how far the three completion
 *     times are staggered (see completionStagger);
 *   - per-request latency (time to first update, total);
 *   - whether any request hit a timeout. Note that core passes no timeout on
 *     session/prompt today — the 30 s default applies to session/new and the
 *     other request methods — so a prompt cannot time out at all right now;
 *   - routing correctness — each session's transcript must contain its own
 *     codeword and none of its siblings' (`liveByNative` under real
 *     interleaved traffic).
 *
 * Engines run strictly SERIALLY here, unlike the live suite: four engine
 * groups at once would put machine contention inside the very intervals this
 * script measures.
 *
 * Usage: pnpm --filter @runskein/conformance st:conc [engineId ...]
 * Output: docs/conformance/st-conc-01.json (+ a console table).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsonlStore, type TranscriptEvent } from '@runskein/core';
// createHub comes from the meta-package: it is the layer that registers the
// four bundled adapters, which core's Hub does not do on its own.
import { builtinAdapters, createHub, EngineOperationError } from 'runskein';
import {
  collectNativeSessionIds,
  deleteEngineSessions,
  liveConfigFor,
  withLiveTimeout,
} from './liveSupport.js';

/** Harness-side ceiling. Core passes no timeout on session/prompt today, so
 * without this a stuck engine would hang the measurement indefinitely. A trip
 * here is recorded as the turn's error, never silently retried. */
const TURN_BUDGET_MS = 240_000;

/** Turns are long enough that serialization is visible in wall-clock, and
 * cheap enough to stay a few hundred tokens. */
const PROMPT = (codeword: string): string =>
  `Write the numbers 1 to 30, one per line. Then, on the very last line, ` +
  `write exactly ${codeword} and nothing after it. Do not use any tools.`;

const CODEWORDS = ['ZEBRA-ALPHA-71', 'ZEBRA-BRAVO-82', 'ZEBRA-CHARLIE-93'] as const;

interface TurnMeasurement {
  codeword: string;
  /** ms from the concurrent fire to the prompt call returning control. */
  totalMs: number;
  /** ms from fire to this session's first streamed update, the best available
   * proxy for when the engine actually started this turn. */
  firstUpdateMs?: number;
  startedAt: number;
  firstUpdateAt?: number;
  endedAt: number;
  stopReason?: string;
  error?: string;
  /** This session's transcript contains its own codeword. */
  ownCodeword: boolean;
  /** Sibling codewords found in this session's transcript — must be empty. */
  foreignCodewords: string[];
}

interface EngineMeasurement {
  engine: string;
  ok: boolean;
  error?: string;
  model?: string;
  /** Engine processes observed after the three sessions existed; 1 proves the
   * sessions really shared a process, which is the premise of the case. */
  processCount: number;
  turns: TurnMeasurement[];
  classification: 'parallel' | 'serialized' | 'partial-overlap' | 'error';
  /** 0 = fully serialized, 1 = perfectly parallel. Secondary signal. */
  overlapRatio: number;
  /** Spread of completion times as a multiple of the first completion; the
   * primary classifier (~N-1 when serialized, ~0 when parallel). */
  completionStagger: number;
  wallClockMs: number;
  sumOfTurnsMs: number;
  timeoutTripped: boolean;
  routingClean: boolean;
}

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

/**
 * Count this process's engine children by engine id on the command line.
 * @param engineId - the engine whose processes to count.
 * @returns the number of matching direct children.
 */
function countEngineChildren(engineId: string): number {
  try {
    const out = execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' });
    let count = 0;
    for (const line of out.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, , ppid, cmd] = m;
      if (Number(ppid) !== process.pid) continue;
      if (cmd === undefined || /tsx|st-conc|vitest/.test(cmd)) continue;
      if (cmd.includes(engineId)) count++;
    }
    return count;
  } catch {
    return -1;
  }
}

/**
 * Completion stagger — the classifier the verdict rests on.
 *
 * All N prompts are fired at the same instant, so [start,end] intervals are
 * nested and cannot discriminate, and "first update" is unreliable because an
 * engine may buffer a turn's updates and flush them at the end (measured:
 * opencode). Completion times cannot be faked that way. If the engine runs the
 * turns one after another, completions are staggered by roughly one turn
 * duration each, so the spread approaches (N-1)x the first completion; if it
 * runs them together, all N land within about one turn of each other.
 * @param turns - the measured turns (successful ones only are considered).
 * @returns spread of completion times as a multiple of the first completion.
 */
function completionStagger(turns: TurnMeasurement[]): number {
  const ends = turns.filter((t) => t.error === undefined).map((t) => t.totalMs);
  if (ends.length < 2) return 0;
  const first = Math.min(...ends);
  if (first === 0) return 0;
  return (Math.max(...ends) - first) / first;
}

/**
 * Derive how much the three turns actually ran at the same time.
 *
 * Each turn occupies [firstUpdate ?? start, end]. Serialized engines produce
 * disjoint intervals, so the union equals the sum; a perfectly parallel engine
 * produces one shared interval, so the union equals the longest turn. Kept as
 * a secondary signal only: it depends on when updates stream, which engines
 * vary in.
 * @param turns - the measured turns.
 * @returns ratio in [0,1]: 0 = fully serialized, 1 = fully parallel.
 */
function computeOverlap(turns: TurnMeasurement[]): number {
  const spans = turns
    .filter((t) => t.error === undefined)
    .map((t) => [t.firstUpdateAt ?? t.startedAt, t.endedAt] as const)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length < 2) return 0;
  const sum = spans.reduce((acc, [a, b]) => acc + (b - a), 0);
  if (sum === 0) return 0;
  // Union length via a sweep.
  let union = 0;
  let cursor = -Infinity;
  for (const [a, b] of spans) {
    const from = Math.max(a, cursor);
    if (b > from) union += b - from;
    cursor = Math.max(cursor, b);
  }
  const longest = Math.max(...spans.map(([a, b]) => b - a));
  // union == sum → disjoint → 0. union == longest → coincident → 1.
  if (sum === longest) return 1;
  return Math.min(1, Math.max(0, (sum - union) / (sum - longest)));
}

/**
 * Read a session's transcript text.
 * @param store - the run's transcript store.
 * @param sessionId - the runskein session id.
 * @returns concatenated agent text for the session.
 */
async function transcriptText(store: ReturnType<typeof jsonlStore>, sessionId: string): Promise<string> {
  let text = '';
  for await (const event of store.read(sessionId) as AsyncIterable<TranscriptEvent>) {
    const update = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.content?.type === 'text') text += update.content.text ?? '';
  }
  return text;
}

/**
 * Measure one engine's behaviour under three concurrent turns.
 * @param engine - the engine id.
 * @returns the engine's measurement row.
 */
async function measure(engine: string): Promise<EngineMeasurement> {
  const row: EngineMeasurement = {
    engine,
    ok: false,
    processCount: -1,
    turns: [],
    classification: 'error',
    overlapRatio: 0,
    completionStagger: 0,
    wallClockMs: 0,
    sumOfTurnsMs: 0,
    timeoutTripped: false,
    routingClean: false,
  };
  const store = jsonlStore(tmp(`runskein-stconc-${engine}-`));
  const hub = createHub({ store });
  const pinned = liveConfigFor(engine).config;
  const pinnedModel = pinned?.['model'];
  if (typeof pinnedModel === 'string') row.model = pinnedModel;
  try {
    // Sessions are created sequentially on purpose: the case measures
    // concurrent PROMPTS on a shared process, and concurrent session/new is a
    // different (already known) contention path.
    const sessions = [];
    for (const codeword of CODEWORDS) {
      sessions.push(
        await hub.session({
          engine,
          cwd: tmp(`runskein-stconc-ws-${engine}-`),
          ...(pinned !== undefined ? { config: pinned } : {}),
        }),
      );
    }
    row.processCount = countEngineChildren(engine);

    const firstUpdateAt = new Map<string, number>();
    for (const s of sessions) {
      s.on('update', () => {
        if (!firstUpdateAt.has(s.id)) firstUpdateAt.set(s.id, Date.now());
      });
    }

    const wallStart = Date.now();
    const settled = await Promise.allSettled(
      sessions.map(async (s, i) => {
        const codeword = CODEWORDS[i]!;
        const startedAt = Date.now();
        try {
          const result = await withLiveTimeout(
            s.prompt(PROMPT(codeword)),
            TURN_BUDGET_MS,
            `prompt ${codeword}`,
          );
          return { i, startedAt, endedAt: Date.now(), stopReason: result.stopReason };
        } catch (error) {
          const endedAt = Date.now();
          if (error instanceof EngineOperationError && /timed? ?out/i.test(error.message)) {
            row.timeoutTripped = true;
          }
          return { i, startedAt, endedAt, error: String(error).split('\n')[0] ?? '' };
        }
      }),
    );
    row.wallClockMs = Date.now() - wallStart;

    for (const outcome of settled) {
      // Every branch above resolves; a rejection here is a harness bug.
      if (outcome.status === 'rejected') throw outcome.reason;
      const { i, startedAt, endedAt, stopReason, error } = outcome.value;
      const s = sessions[i]!;
      const codeword = CODEWORDS[i]!;
      const text = await transcriptText(store, s.id);
      const first = firstUpdateAt.get(s.id);
      row.turns.push({
        codeword,
        totalMs: endedAt - startedAt,
        ...(first !== undefined ? { firstUpdateMs: first - startedAt, firstUpdateAt: first } : {}),
        startedAt,
        endedAt,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(error !== undefined ? { error } : {}),
        ownCodeword: text.includes(codeword),
        foreignCodewords: CODEWORDS.filter((c) => c !== codeword && text.includes(c)),
      });
    }
    row.turns.sort((a, b) => a.startedAt - b.startedAt);
    row.sumOfTurnsMs = row.turns.reduce((acc, t) => acc + t.totalMs, 0);
    row.overlapRatio = computeOverlap(row.turns);
    row.completionStagger = completionStagger(row.turns);
    row.routingClean = row.turns.every((t) => t.ownCodeword && t.foreignCodewords.length === 0);
    const failed = row.turns.filter((t) => t.error !== undefined).length;
    // Stagger decides; overlapRatio only colours the record. Thresholds sit
    // well clear of both ideals (0 parallel, N-1 = 2 serialized for N=3).
    row.classification =
      failed === row.turns.length
        ? 'error'
        : row.completionStagger >= 1.2
          ? 'serialized'
          : row.completionStagger <= 0.7
            ? 'parallel'
            : 'partial-overlap';
    row.ok = failed === 0;

    for (const s of sessions) await s.close().catch(() => undefined);
  } catch (error) {
    row.error = String(error).split('\n')[0] ?? '';
  } finally {
    await hub.quit().catch(() => undefined);
    // Engine-side hygiene: delete the sessions this run created where the
    // engine supports it (measured: kimi and codex).
    const adapter = builtinAdapters.find((a) => a.id === engine);
    if (adapter !== undefined) {
      try {
        const ids = await collectNativeSessionIds(store, engine);
        await deleteEngineSessions(adapter, ids);
      } catch {
        /* cleanup is hygiene, never a gate */
      }
    }
  }
  return row;
}

const wanted = process.argv.slice(2);
const targets = (
  wanted.length ? builtinAdapters.filter((a) => wanted.includes(a.id)) : builtinAdapters
).map((a) => a.id);
if (targets.length === 0) {
  console.error(`unknown engine(s): ${wanted.join(', ')}`);
  process.exitCode = 2;
  throw new Error('no known engine selected');
}

const rows: EngineMeasurement[] = [];
for (const engine of targets) {
  console.log(`\n━━━ ST-CONC-01 ${engine} ━━━`);
  const row = await measure(engine);
  rows.push(row);
  console.log(
    `  ${row.classification}  stagger=${row.completionStagger.toFixed(2)}  overlap=${row.overlapRatio.toFixed(2)}  wall=${row.wallClockMs}ms  ` +
      `sum=${row.sumOfTurnsMs}ms  processes=${row.processCount}  routing=${row.routingClean ? 'clean' : 'CONTAMINATED'}` +
      `${row.timeoutTripped ? '  TIMEOUT-TRIPPED' : ''}${row.error !== undefined ? `  error=${row.error}` : ''}`,
  );
  for (const t of row.turns) {
    console.log(
      `    ${t.codeword}  total=${t.totalMs}ms  firstUpdate=${t.firstUpdateMs ?? '—'}ms  ` +
        `stop=${t.stopReason ?? t.error ?? '—'}  own=${t.ownCodeword}  foreign=[${t.foreignCodewords.join(',')}]`,
    );
  }
}

const out = resolve(import.meta.dirname, '../../../docs/conformance/st-conc-01.json');
writeFileSync(
  out,
  JSON.stringify({ case: 'ST-CONC-01', measuredAt: new Date().toISOString(), engines: rows }, null, 2) +
    '\n',
);
console.log(`\nwrote ${out}`);
