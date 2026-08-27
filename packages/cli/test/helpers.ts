/**
 * Shared harness for the CLI end-to-end suites: stdout and stderr captured
 * separately, exit codes, real signals, and checks for engine processes left
 * behind. Fixtures are temporary adapter packages wrapping either the shared
 * scripted mock agent or the local parameterized one, loaded through
 * `--adapter-path`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(cliDir, '..', '..');
export const mockAgent = resolve(cliDir, '../core/test/fixtures/mock-agent.mjs');
export const scriptedAgent = resolve(cliDir, 'test/fixtures/scripted-agent.mjs');
const mainTs = resolve(cliDir, 'src/main.ts');
const tsxBin = resolve(cliDir, 'node_modules/.bin/tsx');

// ── check bookkeeping ────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;

export function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes++;
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(
      `FAIL ${name}${detail !== undefined ? `\n----- detail -----\n${detail}\n------------------` : ''}`,
    );
  }
}

/** Print the run summary and return the process exit code. */
export function summarize(): number {
  console.log(
    failures === 0 ? `\nall ${passes} checks passed` : `\n${failures} check(s) FAILED (${passes} passed)`,
  );
  return failures === 0 ? 0 : 1;
}

// ── scratch dirs & fixtures ──────────────────────────────────────────────────

export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeAdapterPackage(dir: string, id: string, moduleSource: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `runskein-adapter-${id}`,
      type: 'module',
      main: 'index.mjs',
      runskein: { adapter: true, specVersion: 1 },
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), moduleSource);
}

/** Adapter wrapping core's scripted mock agent (env toggles per fixture). */
export function writeMockAdapter(
  root: string,
  id: string,
  env: Record<string, string> = {},
  extra: { configHints?: unknown[] } = {},
): void {
  writeAdapterPackage(
    join(root, id),
    id,
    `export default {
  specVersion: 1,
  id: ${JSON.stringify(id)},
  launch: {
    command: process.execPath,
    args: [${JSON.stringify(mockAgent)}],
    env: ${JSON.stringify(env)},
  },
${extra.configHints !== undefined ? `  configHints: ${JSON.stringify(extra.configHints)},\n` : ''}};
`,
  );
}

/** Adapter wrapping the parameterized scripted agent (test/fixtures/scripted-agent.mjs). */
export function writeScriptedAdapter(
  root: string,
  id: string,
  script: unknown,
  env: Record<string, string> = {},
  extra: { configHints?: unknown[] } = {},
): void {
  writeAdapterPackage(
    join(root, id),
    id,
    `export default {
  specVersion: 1,
  id: ${JSON.stringify(id)},
  launch: {
    command: process.execPath,
    args: [${JSON.stringify(scriptedAgent)}],
    env: ${JSON.stringify({ SCRIPTED_AGENT_SCRIPT: JSON.stringify(script), ...env })},
  },
${extra.configHints !== undefined ? `  configHints: ${JSON.stringify(extra.configHints)},\n` : ''}};
`,
  );
}

/** Adapter whose module throws on import (failure-isolation fixture). */
export function writeBrokenAdapter(root: string, id = 'broken'): void {
  writeAdapterPackage(join(root, id), id, `throw new Error('broken adapter');\n`);
}

// ── process drivers ──────────────────────────────────────────────────────────

export interface CliResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export function runCli(
  args: string[],
  input?: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): CliResult {
  const res = spawnSync(tsxBin, [mainTs, ...args], {
    cwd: opts.cwd ?? cliDir,
    input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

export interface ChatDriverOpts {
  /** Fixture roots passed as repeatable --adapter-path flags. */
  adapterPaths?: string[];
  /** Extra chat flags (e.g. --permission ask, --resume <id>). */
  extra?: string[];
  /** Session --cwd (scratch dir; transcripts land here). */
  chatCwd: string;
  /** cwd of the CLI process itself (defaults to packages/cli). */
  cliCwd?: string;
  /** Extra environment for the CLI process, merged over process.env. */
  env?: Record<string, string>;
}

/** Interactive chat driver with paced writes and real-signal support. */
export class ChatDriver {
  private readonly child: ChildProcess;
  private combined = '';
  stdout = '';
  stderr = '';
  private exitCode: number | null | undefined;

  constructor(engine: string, opts: ChatDriverOpts) {
    const args = [
      ...(opts.adapterPaths ?? []).flatMap((p) => ['--adapter-path', p]),
      'chat',
      engine,
      '--cwd',
      opts.chatCwd,
      ...(opts.extra ?? []),
    ];
    this.child = spawn(tsxBin, [mainTs, ...args], {
      cwd: opts.cliCwd ?? cliDir,
      env: { ...process.env, ...opts.env },
    });
    // A timeout may kill the child before a suite's fallback `:quit` write.
    this.child.stdin?.on('error', (error: Error & { code?: string }) => {
      if (error.code !== 'EPIPE') throw error;
    });
    this.child.on('exit', (code) => {
      this.exitCode = code;
    });
    this.child.stdout?.on('data', (d: Buffer) => {
      this.stdout += d.toString();
      this.combined += d.toString();
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr += d.toString();
      this.combined += d.toString();
    });
  }

  write(line: string): void {
    if (this.exitCode !== undefined) return;
    this.child.stdin?.write(`${line}\n`);
  }

  endInput(): void {
    this.child.stdin?.end();
  }

  /** Simulate a downstream pipeline consumer such as `head` exiting early. */
  closeStdout(): void {
    this.child.stdout?.destroy();
  }

  /** Send a real signal to the CLI process (CL-04…07). */
  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  waitFor(needle: string, timeoutMs = 20_000): Promise<void> {
    return this.waitForCount(needle, 1, timeoutMs);
  }

  waitForCount(needle: string, count: number, timeoutMs = 20_000): Promise<void> {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (this.combined.split(needle).length - 1 >= count) {
          clearInterval(timer);
          res();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          this.child.kill('SIGKILL');
          rej(
            new Error(
              `timeout waiting for ${count}x ${JSON.stringify(needle)}\n--- output ---\n${this.combined}`,
            ),
          );
        }
      }, 25);
    });
  }

  exit(timeoutMs = 20_000): Promise<number | null> {
    if (this.exitCode !== undefined) return Promise.resolve(this.exitCode);
    return new Promise((res) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!this.child.kill('SIGKILL')) res(null);
      }, timeoutMs);
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        res(timedOut ? null : code);
      });
    });
  }
}

/** Escape a path so pgrep's extended regular expression matches it literally. */
function literal(path: string): string {
  return path.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

/**
 * Fixture engine process the scripted-agent suites spawn, as pgrep sees it.
 *
 * Anchored to this checkout's absolute fixture path, not the bare file name:
 * pgrep matches every process on the machine, and the same agents ship inside
 * `@runskein/testkit`, so a bare name also matches an unrelated project's
 * test run and reports it as an engine this suite failed to reap.
 */
export const SCRIPTED_AGENT_PATTERN = literal(scriptedAgent);

/**
 * Fixture engine processes the CLI spawns (mock + scripted agents).
 *
 * Other workspace packages spawn the very same mock agent, so their processes
 * are indistinguishable from this suite's even when anchored by path; the root
 * `test` script runs workspace packages one at a time for that reason.
 */
const ENGINE_PROCESS_PATTERN = `${literal(mockAgent)}|${SCRIPTED_AGENT_PATTERN}`;

/** Synchronous sleep (Atomics.wait does not block the event loop). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Kill any fixture engine process left over from an earlier (possibly
 * interrupted) run, so the teardown gate below only sees this run's processes.
 */
export function cleanStaleEngines(): void {
  const res = spawnSync('pgrep', ['-f', ENGINE_PROCESS_PATTERN], { encoding: 'utf8' });
  if (res.status !== 0) return; // none running
  for (const pid of res.stdout.trim().split(/\s+/)) {
    if (!pid) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // Give the killed children a moment to actually exit.
  sleepSync(200);
}

/**
 * True when no fixture engine process survives. A CLI exit races the child
 * SIGTERM→SIGKILL teardown, so this polls until the processes are gone rather
 * than asserting immediately; a process still alive after the grace period is
 * a real "engine not reaped" regression.
 * @param pattern - pgrep pattern to match (default: the fixture agents).
 * @param timeoutMs - how long to wait for a match to disappear (default 5 s).
 * @returns true when no matching process survives within the timeout.
 */
export function noLingering(pattern = ENGINE_PROCESS_PATTERN, timeoutMs = 5_000): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    if (res.status !== 0) return true; // no match
    if (Date.now() >= deadline) return false; // still alive after the grace period
    sleepSync(100);
  }
}
