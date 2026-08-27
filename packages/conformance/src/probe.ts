/**
 * Conformance probe — measures what real engines actually support and writes
 * the capability matrix that the rest of the project treats as the baseline.
 *
 * It runs on the library's own internals — the same env-hygiene spawn, process
 * lifecycle, JSON-RPC framing, and capability normalization the library uses —
 * so what it measures is what consumers will get.
 *
 * Per engine:
 *   spawn → initialize (caps) → session/new (modes/configOptions) →
 *   prompt (update stream, stopReason) → session/close → quit chain
 *
 * Usage: pnpm probe [engineId ...]     (default: all)
 * Output: docs/conformance/matrix.json + per-engine raw dumps alongside it.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ProcessManager,
  autoAllowPermission,
  withTimeout,
  type SessionUpdateNotification,
} from '@runskein/core/internal';
import type { EngineAdapter } from '@runskein/core';
import { SessionTerminals } from '@runskein/core/internal';
import { builtinAdapters } from 'runskein';
import { computeUsageRow } from './usageSupport.js';

// ── Engine launch manifests — the bundled adapters/* packages ─────────

const MANIFESTS: EngineAdapter[] = [...builtinAdapters];

// ── Probe result shape (matrix.json rows — keep stable) ────────────────────

interface ProbeResult {
  id: string;
  ok: boolean;
  error?: string;
  protocolVersion?: string | number;
  agentInfo?: unknown;
  capabilities?: {
    loadSession?: boolean;
    session?: Record<string, boolean>; // list/delete/fork/resume/close/...
    prompt?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
    providers?: boolean;
  };
  authMethods?: unknown;
  modes?: { current: string; available: { id: string; name: string }[] } | null;
  models?: { current?: string; available: { id: string; name: string }[] } | null;
  configOptions?: {
    id: string;
    name: string;
    category?: string | null;
    type: string;
    options?: unknown;
  }[];
  prompt?: {
    stopReason?: string;
    updateKinds: Record<string, number>;
    sawUsage: boolean;
    permissionRequests: number;
    replyText?: string;
    durationMs: number;
  };
  /**
   * UA-MTX-01 — the measured `usage` matrix row (test plan §4): whether the
   * adapter's declared mapping resolved on this engine's captured turn, which
   * runskein Usage keys resolved, and under which semantics. A mapping is
   * trustable only while this row is current.
   */
  usage?: {
    ok: boolean;
    source: string;
    fields: string[];
    semantics: string;
  };
  /**
   * Whether the engine can actually run a command, which is not answerable
   * from `initialize`: engines that execute in their own process and engines
   * that delegate to the client both advertise nothing about it, and the
   * second kind fails every command tool when the client declines terminals.
   */
  commandExecution?: {
    ok: boolean;
    usedClientTerminal: boolean;
    detail: string;
  };
  close?: 'closed' | 'not-supported' | 'error';
  raw: Record<string, unknown>;
}

// ── Per-engine probe ───────────────────────────────────────────────────────

/**
 * Run the capability probe against one engine.
 * @param adapter - the engine adapter.
 * @returns the probe summary (capabilities, modes, configOptions, prompt, close).
 */
async function probe(adapter: EngineAdapter): Promise<ProbeResult> {
  const result: ProbeResult = { id: adapter.id, ok: false, raw: {} };
  const cwd = mkdtempSync(join(tmpdir(), `runskein-probe-${adapter.id}-`));
  writeFileSync(join(cwd, 'README.md'), `# probe workspace for ${adapter.id}\n`);

  // Update stream — collected as it arrives, summarized after the turn.
  const updates: SessionUpdateNotification[] = [];
  let permissionRequests = 0;
  let terminalCreates = 0;
  const terminals = new SessionTerminals(cwd);
  const manager = new ProcessManager({
    handlers: {
      onUpdate: (n) => updates.push(n),
      onPermissionRequest: (params) => {
        permissionRequests++;
        return autoAllowPermission(params);
      },
      // The probe runs terminals itself rather than through a Session: it has
      // no policy to consult, and counting the calls is the measurement.
      onTerminal: {
        create: (params) => {
          terminalCreates++;
          return Promise.resolve({
            terminalId: terminals.create({
              command: String(params.command),
              args: Array.isArray(params.args) ? params.args : [],
              cwd: terminals.resolveCwd(params.cwd),
              ...(params.outputByteLimit != null ? { outputByteLimit: params.outputByteLimit } : {}),
            }),
          });
        },
        output: (params) => Promise.resolve(terminals.output(String(params.terminalId))),
        waitForExit: (params) => terminals.waitForExit(String(params.terminalId)),
        kill: async (params) => {
          await terminals.kill(String(params.terminalId));
        },
        release: async (params) => {
          await terminals.release(String(params.terminalId));
        },
      },
    },
  });

  const startTimeoutMs = adapter.launch.startTimeoutMs ?? 30_000;
  try {
    await withTimeout(
      (async () => {
        // 1. spawn + initialize (the library handles env scrubbing and the
        //    spawn-failure race)
        const acquired = await manager.acquire(adapter, { cwd });
        const { connection } = acquired;
        try {
          const init = connection.initializeResult!;
          if (init.protocolVersion !== undefined) result.protocolVersion = init.protocolVersion;
          result.agentInfo = init.agentInfo;
          result.authMethods = init.authMethods;
          result.capabilities = connection.capabilities;
          result.raw.initialize = init;

          // 2. session/new
          const sess = await connection.newSession({ cwd }, { timeoutMs: 30_000 });
          result.raw.sessionNew = sess;
          result.modes = sess.modes
            ? {
                current: sess.modes.currentModeId,
                available: sess.modes.availableModes.map((x) => ({ id: x.id, name: x.name })),
              }
            : null;
          // Model choice is a surface of its own: engines may advertise it
          // here, as a config option, or both, and setConfig routes on which.
          result.models = sess.models
            ? {
                ...(sess.models.currentModelId !== undefined
                  ? { current: sess.models.currentModelId }
                  : {}),
                available: sess.models.availableModels.map((x) => ({
                  id: x.modelId,
                  name: x.name,
                })),
              }
            : null;
          result.configOptions = (sess.configOptions ?? []).map((raw) => {
            const o = raw as Record<string, unknown>;
            return {
              id: String(o['id']),
              name: String(o['name']),
              category: (o['category'] as string | undefined) ?? null,
              type: String(o['type']),
              options: o['options'],
            };
          });

          // 3. prompt — tiny, deterministic, no tools needed
          const t0 = Date.now();
          const resp = await connection.prompt(
            {
              sessionId: sess.sessionId,
              prompt: [
                {
                  type: 'text',
                  text: 'Reply with exactly the word OK and nothing else. Do not use any tools.',
                },
              ],
            },
            { timeoutMs: 180_000 },
          );
          const updateKinds: Record<string, number> = {};
          let replyText = '';
          let sawUsage = false;
          for (const u of updates) {
            const kind = u.update.sessionUpdate;
            updateKinds[kind] = (updateKinds[kind] ?? 0) + 1;
            const content = u.update['content'] as { type?: string; text?: string } | undefined;
            if (kind === 'agent_message_chunk' && content?.type === 'text') replyText += content.text ?? '';
            if (kind === 'usage_update') sawUsage = true;
          }
          result.prompt = {
            stopReason: resp.stopReason,
            updateKinds,
            sawUsage,
            permissionRequests,
            replyText: replyText.slice(0, 200),
            durationMs: Date.now() - t0,
          };
          result.raw.promptResponse = resp;
          // Snapshot BEFORE the second prompt below appends to the same array:
          // the usage row describes the accounting turn, not the whole run.
          result.usage = computeUsageRow(adapter, resp, updates.slice());
          result.raw.updates = updates;

          // 3b. command execution — the one capability no engine advertises.
          //     A file with a known marker is read back through whatever tool
          //     the engine reaches for; the answer proves it ran something.
          const marker = `runskein-probe-${Math.abs(Date.now() % 100000)}`;
          writeFileSync(join(cwd, 'marker.txt'), `${marker}\n`);
          const beforeCreates = terminalCreates;
          const commandUpdates = updates.length;
          try {
            const cmd = await connection.prompt(
              {
                sessionId: sess.sessionId,
                prompt: [
                  {
                    type: 'text',
                    text: 'Run the shell command `cat marker.txt` in the current directory using your tools, then reply with only what it printed.',
                  },
                ],
              },
              { timeoutMs: 180_000 },
            );
            let text = '';
            const failures: string[] = [];
            for (const u of updates.slice(commandUpdates)) {
              const content = u.update['content'] as { type?: string; text?: string } | undefined;
              if (u.update.sessionUpdate === 'agent_message_chunk' && content?.type === 'text') {
                text += content.text ?? '';
              }
              if (u.update['status'] === 'failed')
                failures.push(JSON.stringify(u.update['rawOutput'] ?? ''));
            }
            result.commandExecution = {
              ok: text.includes(marker),
              usedClientTerminal: terminalCreates > beforeCreates,
              detail: text.includes(marker)
                ? `read the marker back (stopReason ${cmd.stopReason})`
                : `marker not returned (stopReason ${cmd.stopReason})${failures.length ? `; failed tools: ${failures.join(' ')}` : ''}`,
            };
          } catch (e) {
            result.commandExecution = {
              ok: false,
              usedClientTerminal: terminalCreates > beforeCreates,
              detail: `prompt failed: ${(e as Error).message}`,
            };
          }

          // 4. session/close — optional per engine, so record the outcome
          //    instead of failing the probe
          try {
            await connection.closeSession(sess.sessionId, { timeoutMs: 10_000 });
            result.close = 'closed';
          } catch (e) {
            result.close = /method not found|not supported|-32601/i.test(String(e))
              ? 'not-supported'
              : 'error';
            result.raw.closeError = String(e);
          }
          result.ok = true;
        } finally {
          // Whatever the engine left running was started by this probe.
          void terminals.releaseAll();
          acquired.release();
        }
      })(),
      startTimeoutMs + 240_000,
      `${adapter.id} overall`,
    );
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    try {
      await manager.quit(adapter.id);
    } catch (e) {
      result.ok = false;
      result.error = [result.error, `quit failed: ${(e as Error).message}`].filter(Boolean).join('; ');
    }
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

const wanted = process.argv.slice(2);
const targets = wanted.length ? MANIFESTS.filter((m) => wanted.includes(m.id)) : MANIFESTS;
if (!targets.length) {
  console.error(`unknown engine(s): ${wanted.join(', ')}. known: ${MANIFESTS.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '../../../docs/conformance');
mkdirSync(outDir, { recursive: true });

const results: ProbeResult[] = [];
for (const m of targets) {
  console.error(`\n━━ probing ${m.id} (${m.launch.command} ${(m.launch.args ?? []).join(' ')}) ...`);
  const r = await probe(m);
  results.push(r);
  const { raw, ...summary } = r;
  writeFileSync(join(outDir, `${m.id}.raw.json`), JSON.stringify(raw, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  // On success, refresh the adapter's committed conformance.json so a fresh
  // run always matches what is checked in; any diff is then deliberate drift
  // that shows up in review rather than silently.
  if (r.ok) {
    const adapterDir = resolve(import.meta.dirname, '../../../adapters', m.id);
    mkdirSync(adapterDir, { recursive: true });
    writeFileSync(join(adapterDir, 'conformance.json'), JSON.stringify(summary, null, 2));
    console.error(`━━ wrote ${join(adapterDir, 'conformance.json')}`);
  }
}

// Matrix: summaries only. Partial probes replace only selected rows so a
// documented `pnpm probe <id>` run cannot erase the other engines' evidence.
const matrixPath = join(outDir, 'matrix.json');
const previous: Omit<ProbeResult, 'raw'>[] =
  wanted.length > 0 && existsSync(matrixPath)
    ? (JSON.parse(readFileSync(matrixPath, 'utf8')) as Omit<ProbeResult, 'raw'>[])
    : [];
const byId = new Map(previous.map((row) => [row.id, row]));
for (const { raw: _raw, ...summary } of results) byId.set(summary.id, summary);
const matrix = MANIFESTS.map((manifest) => byId.get(manifest.id)).filter(
  (row): row is Omit<ProbeResult, 'raw'> => row !== undefined,
);
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));
console.error(`\n━━ wrote ${matrixPath}`);

// Compact terminal table.
const rows = results.map((r) => ({
  engine: r.id,
  ok: r.ok ? '✅' : '❌',
  proto: String(r.protocolVersion ?? '-'),
  load: r.capabilities?.loadSession ? '✓' : '·',
  resume: r.capabilities?.session?.resume ? '✓' : '·',
  fork: r.capabilities?.session?.fork ? '✓' : '·',
  list: r.capabilities?.session?.list ? '✓' : '·',
  close: r.close === 'closed' ? '✓' : r.close === 'not-supported' ? '·' : '?',
  modes: String(r.modes?.available.length ?? 0),
  models: String(r.models?.available.length ?? 0),
  cfgOpts: String(r.configOptions?.length ?? 0),
  usage: r.prompt?.sawUsage ? '✓' : '·',
  // 'term' marks an engine that ran its command through the client rather
  // than in its own process — the difference that decides whether declining
  // the terminal capability costs it every command tool.
  cmd: r.commandExecution
    ? r.commandExecution.ok
      ? r.commandExecution.usedClientTerminal
        ? 'term'
        : '✓'
      : '✗'
    : '-',
  stop: r.prompt?.stopReason ?? '-',
  reply: (r.prompt?.replyText ?? r.error ?? '').slice(0, 40),
}));
console.table(rows);
