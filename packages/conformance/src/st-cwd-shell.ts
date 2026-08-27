/**
 * ST-CWD-02 — shell-tool cwd measurement (AC-6.2).
 *
 * Appendix A.3 measured that all four engines resolve FILE operations from
 * the per-session cwd, which is why workspace isolation currently lives
 * entirely in L2. The shell/terminal path was never probed, and it is a
 * separate implementation per engine: a build or test run in the wrong tree
 * damages exactly like a misplaced write. The result decides whether
 * per-session shell cwd stays a free Core guarantee or becomes a Negotiated
 * `workspace.shellCwd` capability with a typed pre-session rejection.
 *
 * Protocol per engine: two sessions on ONE process with two different cwds,
 * each asked to run `pwd` through the engine's own shell/terminal tool. The
 * second session is the load-bearing one — the process was launched with the
 * FIRST session's cwd (first acquire wins), so session B passing proves the
 * engine resolves the subprocess cwd per session rather than per process.
 *
 * The oracle is the reported path, compared against both the literal and the
 * realpath form of the seeded directory (macOS /var → /private/var). A tool
 * call is recorded separately so "the model answered from memory" is
 * distinguishable from "the shell really ran there".
 *
 * Usage: pnpm --filter @runskein/conformance st:cwd [engineId ...]
 * Output: docs/conformance/st-cwd-02.json (+ a console table).
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { jsonlStore, type TranscriptEvent } from '@runskein/core';
// createHub comes from the meta-package: it is the layer that registers the
// four bundled adapters, which core's Hub does not do on its own.
import { builtinAdapters, createHub } from 'runskein';
import {
  LIVE_MODEL_PINS,
  collectNativeSessionIds,
  deleteEngineSessions,
  withLiveTimeout,
} from './liveSupport.js';

const PROMPT =
  'Run the shell command `pwd` using your terminal or command-execution tool, ' +
  'then reply with exactly the one line it printed and nothing else. ' +
  'Do not answer from memory — you must actually run the command.';

/** Harness-side ceiling: core passes no timeout on session/prompt, so a
 * stuck engine would otherwise hang the measurement. */
const TURN_BUDGET_MS = 180_000;

interface SessionProbe {
  label: 'A' | 'B';
  /** The cwd this session was created with. */
  cwd: string;
  realCwd: string;
  replyText: string;
  /** The reply names this session's own cwd. */
  correct: boolean;
  /** The reply names the sibling session's cwd — the isolation failure. */
  reportedSibling: boolean;
  /** An execute-kind tool call was observed, so a shell really ran. */
  sawShellTool: boolean;
  error?: string;
}

interface EngineMeasurement {
  engine: string;
  ok: boolean;
  error?: string;
  model?: string;
  probes: SessionProbe[];
  /** Both sessions reported their own cwd. */
  shellCwdIsolated: boolean;
}

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

/**
 * Seed a workspace so the engine has something to look at besides an empty dir.
 * @param engine - engine id, used in the directory name.
 * @param label - session label.
 * @returns the created workspace path.
 */
function workspace(engine: string, label: string): string {
  const dir = tmp(`runskein-stcwd-${engine}-${label}-`);
  writeFileSync(join(dir, 'README.md'), `# workspace ${label} for ${engine}\n`);
  writeFileSync(join(dir, `marker-${label}.txt`), `this is workspace ${label}\n`);
  return dir;
}

/**
 * Read a session's agent text and whether it made an execute-kind tool call.
 * @param store - the run's transcript store.
 * @param sessionId - the runskein session id.
 * @returns the concatenated agent text and the shell-tool observation.
 */
async function readSession(
  store: ReturnType<typeof jsonlStore>,
  sessionId: string,
): Promise<{ text: string; sawShellTool: boolean }> {
  let text = '';
  let sawShellTool = false;
  for await (const event of store.read(sessionId) as AsyncIterable<TranscriptEvent>) {
    const update = event.update as {
      sessionUpdate?: string;
      kind?: string;
      title?: string;
      content?: { type?: string; text?: string };
    };
    if (update.content?.type === 'text' && update.sessionUpdate === 'agent_message_chunk') {
      text += update.content.text ?? '';
    }
    if (
      update.sessionUpdate === 'tool_call' &&
      (update.kind === 'execute' || /pwd|bash|shell|terminal/i.test(update.title ?? ''))
    ) {
      sawShellTool = true;
    }
  }
  return { text, sawShellTool };
}

/**
 * Measure one engine's per-session shell cwd.
 * @param engine - the engine id.
 * @returns the engine's measurement row.
 */
async function measure(engine: string): Promise<EngineMeasurement> {
  const row: EngineMeasurement = { engine, ok: false, probes: [], shellCwdIsolated: false };
  const store = jsonlStore(tmp(`runskein-stcwd-store-${engine}-`));
  const hub = createHub({ store });
  const pin = LIVE_MODEL_PINS[engine];
  if (pin !== undefined) row.model = pin.model;
  try {
    const dirs = { A: workspace(engine, 'A'), B: workspace(engine, 'B') } as const;
    const sessions: Array<{ label: 'A' | 'B'; cwd: string; s: Awaited<ReturnType<typeof hub.session>> }> =
      [];
    for (const label of ['A', 'B'] as const) {
      sessions.push({
        label,
        cwd: dirs[label],
        s: await hub.session({
          engine,
          cwd: dirs[label],
          ...(pin !== undefined ? { config: { model: pin.model } } : {}),
        }),
      });
    }

    // Serial turns: this case is about cwd resolution, and concurrency is
    // ST-CONC-01's variable — mixing them would confound both.
    for (const { label, cwd, s } of sessions) {
      const realCwd = realpathSync(cwd);
      const sibling = label === 'A' ? dirs.B : dirs.A;
      const realSibling = realpathSync(sibling);
      const probe: SessionProbe = {
        label,
        cwd,
        realCwd,
        replyText: '',
        correct: false,
        reportedSibling: false,
        sawShellTool: false,
      };
      try {
        await withLiveTimeout(s.prompt(PROMPT), TURN_BUDGET_MS, `pwd ${label}`);
        const { text, sawShellTool } = await readSession(store, s.id);
        probe.replyText = text.trim().slice(0, 400);
        probe.sawShellTool = sawShellTool;
        probe.correct = text.includes(realCwd) || text.includes(cwd);
        probe.reportedSibling = text.includes(realSibling) || text.includes(sibling);
      } catch (error) {
        probe.error = String(error).split('\n')[0] ?? '';
      }
      row.probes.push(probe);
    }

    row.shellCwdIsolated =
      row.probes.length === 2 && row.probes.every((p) => p.correct && !p.reportedSibling);
    row.ok = row.probes.every((p) => p.error === undefined);
    for (const { s } of sessions) await s.close().catch(() => undefined);
  } catch (error) {
    row.error = String(error).split('\n')[0] ?? '';
  } finally {
    await hub.quit().catch(() => undefined);
    const adapter = builtinAdapters.find((a) => a.id === engine);
    if (adapter !== undefined) {
      try {
        await deleteEngineSessions(adapter, await collectNativeSessionIds(store, engine));
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
  console.log(`\n━━━ ST-CWD-02 ${engine} ━━━`);
  const row = await measure(engine);
  rows.push(row);
  for (const p of row.probes) {
    console.log(
      `  session ${p.label}  correct=${p.correct}  reportedSibling=${p.reportedSibling}  ` +
        `shellTool=${p.sawShellTool}${p.error !== undefined ? `  error=${p.error}` : ''}`,
    );
    console.log(`    cwd=${p.realCwd}`);
    console.log(`    reply=${JSON.stringify(p.replyText.slice(0, 160))}`);
  }
  console.log(
    `  → shellCwdIsolated=${row.shellCwdIsolated}${row.error !== undefined ? ` error=${row.error}` : ''}`,
  );
}

const out = resolve(import.meta.dirname, '../../../docs/conformance/st-cwd-02.json');
writeFileSync(
  out,
  JSON.stringify({ case: 'ST-CWD-02', measuredAt: new Date().toISOString(), engines: rows }, null, 2) +
    '\n',
);
console.log(`\nwrote ${out}`);
