/**
 * Terminals run for the agent.
 *
 * An engine that delegates command execution asks the client to run it. Since
 * runskein is the one spawning the process, these cases are about the boundaries
 * that come with that: the permission policy decides, the session's working
 * directory is the ceiling, and nothing survives the session that authorised
 * it. The transport itself is covered too — an engine has to be able to read
 * output, wait for exit, kill, and release.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, jsonlStore, type EngineAdapter, type Hub, type TranscriptEvent } from '../src/index.js';
import { authorizeTerminalEnv, SessionTerminals } from '../src/process/terminal.js';
import { mockAdapter } from './testkit.js';

const hubs: Hub[] = [];
const scratch = (): string => mkdtempSync(join(tmpdir(), 'runskein-term-'));

/**
 * A hub whose mock engine runs one command through the client each turn.
 * @param spec - the command the fixture should ask the client to run.
 * @param extra - further fixture toggles.
 * @returns the hub.
 */
function hub(spec: Record<string, unknown>, extra: Record<string, string> = {}): Hub {
  const base = mockAdapter();
  const adapter: EngineAdapter = {
    ...base,
    launch: {
      ...base.launch,
      env: { ...base.launch.env, MOCK_TERMINAL_RUN: JSON.stringify(spec), ...extra },
    },
  };
  const created = createHub({ discovery: false, adapters: [adapter], store: jsonlStore(scratch()) });
  hubs.push(created);
  return created;
}

/** What the fixture reported back about the command it asked the client to run. */
function terminalReport(updates: TranscriptEvent[]): Record<string, unknown> | undefined {
  const update = updates
    .map((e) => e.update as { sessionUpdate: string; toolCallId?: string; rawOutput?: unknown })
    .find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId?.startsWith('term-run-'));
  return update?.rawOutput as Record<string, unknown> | undefined;
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit()));
});

describe('terminals run for the agent', () => {
  it('runs a command and reports its output and exit status', async () => {
    const h = hub({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello-from-terminal")'],
    });
    const s = await h.session({ engine: 'mock', cwd: scratch() });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));

    await s.prompt('run it');

    const report = terminalReport(updates);
    expect(report?.['output']).toBe('hello-from-terminal');
    expect((report?.['exitStatus'] as { exitCode?: number })?.exitCode).toBe(0);
    expect(report?.['truncated']).toBe(false);
  }, 30_000);

  it('runs in the session cwd by default', async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, 'marker.txt'), 'found');
    const h = hub({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(require("fs").readFileSync("marker.txt","utf8"))'],
    });
    const s = await h.session({ engine: 'mock', cwd });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');
    expect(terminalReport(updates)?.['output']).toBe('found');
  }, 30_000);

  it('refuses a working directory outside the session', async () => {
    // The session's cwd is the boundary the host set. An agent may narrow it
    // and may not move it, whatever path it asks for.
    const h = hub({ command: process.execPath, args: ['-e', 'process.stdout.write("nope")'], cwd: '/tmp' });
    const s = await h.session({ engine: 'mock', cwd: scratch() });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');
    expect(String(terminalReport(updates)?.['error'])).toMatch(/outside the session/);
  }, 30_000);

  it('asks the permission policy before running anything', async () => {
    const h = hub({ command: process.execPath, args: ['-e', 'process.stdout.write("ran")'] });
    const seen: { tool: string; kind?: string; input: unknown }[] = [];
    const s = await h.session({
      engine: 'mock',
      cwd: scratch(),
      permissionPolicy: (request) => {
        seen.push({
          tool: request.tool,
          ...(request.kind ? { kind: request.kind } : {}),
          input: request.input,
        });
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: 'terminal', kind: 'execute' });
    expect((seen[0]?.input as { command?: string })?.command).toBe(process.execPath);
    expect(terminalReport(updates)?.['output']).toBe('ran');
  }, 30_000);

  it('shows the policy the environment the command would run with', async () => {
    const h = hub({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.MY_FLAG ?? "unset")'],
      env: [{ name: 'MY_FLAG', value: 'set' }],
    });
    const seen: unknown[] = [];
    const s = await h.session({
      engine: 'mock',
      cwd: scratch(),
      permissionPolicy: (request) => {
        seen.push(request.input);
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');

    expect((seen[0] as { env?: unknown })?.env).toEqual([{ name: 'MY_FLAG', value: 'set' }]);
    expect(terminalReport(updates)?.['output']).toBe('set');
  }, 30_000);

  it('refuses a request that would redirect an allowed command, before the policy sees it', async () => {
    // A rule table allowing a command allows a program. PATH would decide
    // which program that is, so the request is refused rather than presented
    // as something a policy could sensibly say yes to.
    const h = hub({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ran")'],
      env: [{ name: 'PATH', value: '/tmp/evil' }],
    });
    let asked = 0;
    const s = await h.session({
      engine: 'mock',
      cwd: scratch(),
      permissionPolicy: () => {
        asked++;
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');

    expect(String(terminalReport(updates)?.['error'])).toMatch(/'PATH' may not be set/);
    expect(asked).toBe(0);
  }, 30_000);

  it('a denied command never runs', async () => {
    const marker = join(scratch(), 'should-not-exist.txt');
    const h = hub({
      command: process.execPath,
      args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    });
    const s = await h.session({
      engine: 'mock',
      cwd: scratch(),
      permissionPolicy: () => ({ outcome: 'deny' }),
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');

    expect(String(terminalReport(updates)?.['error'])).toMatch(/refused by permission policy/);
    // Refusing has to mean the command did not run, not that its result was
    // discarded afterwards.
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('kills a running command on request and keeps its output readable', async () => {
    const h = hub(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("started");setInterval(()=>{},1000)'],
      },
      { MOCK_TERMINAL_KILL: '1' },
    );
    const s = await h.session({ engine: 'mock', cwd: scratch() });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');
    const report = terminalReport(updates);
    expect(report?.['output']).toBe('started');
  }, 30_000);

  it('leaves no command running when the session closes', async () => {
    // The agent starts something long-running and walks away without releasing
    // it. Nothing else will ever collect that process, so the session must.
    //
    // This case has failed on a loaded machine and passed alone on the same
    // tree. Whether it should be sensitive to load at all is a real question —
    // the assertion is "the process is gone after close()", and whether that
    // takes 200ms or 8s is a different question from whether it happens — but
    // it is not answerable until a failure says which. That is what the wait
    // below now reports; deciding it on the evidence comes after.
    const cwd = scratch();
    const pidFile = join(cwd, 'pid.txt');
    const h = hub(
      {
        command: process.execPath,
        args: [
          '-e',
          `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`,
        ],
      },
      { MOCK_TERMINAL_LEAVE: '1' },
    );
    const s = await h.session({ engine: 'mock', cwd });
    await s.prompt('run it');
    await waitFor(() => existsSync(pidFile), `the command to write its pid to ${pidFile}`);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    await s.close();
    await waitFor(
      () => !alive(pid),
      () =>
        `the command process ${String(pid)} to exit after close(); it is ${alive(pid) ? 'still alive' : 'gone'}`,
    );
    expect(alive(pid)).toBe(false);
  }, 30_000);
});

/**
 * Whether a pid is still running.
 * @param pid - the process id to test.
 * @returns true while the process exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How often the poller re-tests its condition. */
const POLL_INTERVAL_MS = 25;

/**
 * Poll until a condition holds.
 *
 * The budget is deliberately smaller than the case's vitest timeout, so this is
 * always the error a reader sees. That made the message load-bearing and it used
 * to be `condition never held` — identical for every call in this file, naming
 * neither what was awaited nor for how long. A contributor hitting it on a busy
 * machine could not tell a slow teardown from a regression in the thing under
 * test, and the two conclusions available to them — "I broke it" and "the suite
 * is unreliable" — were both worse than the truth.
 *
 * The budget is not the lever. Ten seconds for a `SIGTERM` to be observed is
 * already generous, and raising it buys quiet by making the case blind to the
 * regression it exists to catch.
 *
 * @param condition - the predicate to wait for.
 * @param describe - what is being awaited. A function is called at the deadline,
 *   so it can report the state that is still wrong rather than the state at the
 *   start.
 * @param timeoutMs - how long to keep trying.
 * @throws `Error` naming the wait, its budget, and what was still true at the end.
 */
async function waitFor(
  condition: () => boolean,
  describe: string | (() => string),
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const what = typeof describe === 'function' ? describe() : describe;
  throw new Error(
    `waited ${String(Date.now() - started)}ms (budget ${String(timeoutMs)}ms, ` +
      `polling every ${String(POLL_INTERVAL_MS)}ms) for ${what}`,
  );
}

describe('waitFor', () => {
  it('says what it waited for, for how long, and what was still true', async () => {
    // The message is the whole point of this helper, so it is asserted rather
    // than assumed. `condition never held` was the same string for every call
    // in this file, and a contributor who hit it could not tell a slow teardown
    // from a regression in the thing under test.
    let polls = 0;
    const error = await waitFor(
      () => {
        polls += 1;
        return false;
      },
      () => `something that never happens (polled ${String(polls)} times)`,
      120,
    ).catch((cause: unknown) => cause as Error);

    expect(error.message).toMatch(/^waited \d+ms \(budget 120ms, polling every 25ms\) for /);
    expect(error.message).toContain('something that never happens');
    // The describer runs at the deadline, not at the start, so it can report the
    // state that is still wrong. Asserted by comparing the count it captured
    // against the final one rather than against a number: how many polls fit in
    // 120ms is exactly the machine-speed question this whole change is about,
    // and an assertion on it would be the defect it is meant to remove.
    expect(error.message).toContain(`polled ${String(polls)} times`);
  });

  it('does not call the describer when the condition holds', async () => {
    let described = false;
    await waitFor(
      () => true,
      () => {
        described = true;
        return 'never';
      },
    );
    expect(described).toBe(false);
  });
});

describe('a session with a live command', () => {
  it('keeps its engine while a command is still running', async () => {
    // A session whose turn queue is empty looks idle. It is not idle while it
    // is running something for the agent: suspending releases the engine
    // reference, the engine is then reaped, and the agent can never read back
    // the output of a command that is still running.
    const cwd = scratch();
    const pidFile = join(cwd, 'pid.txt');
    const base = mockAdapter();
    const adapter: EngineAdapter = {
      ...base,
      launch: {
        ...base.launch,
        env: {
          ...base.launch.env,
          MOCK_TERMINAL_LEAVE: '1',
          MOCK_TERMINAL_RUN: JSON.stringify({
            command: process.execPath,
            args: [
              '-e',
              `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(()=>{}, 10000)`,
            ],
          }),
        },
      },
    };
    const h = createHub({
      discovery: false,
      adapters: [adapter],
      store: jsonlStore(scratch()),
      // Both clocks short: the session lets go after 50ms of idleness, and the
      // engine is reaped as soon as nothing holds it.
      defaults: { idleTimeoutMs: 50 },
    });
    hubs.push(h);

    const s = await h.session({ engine: 'mock', cwd, sessionIdleTimeoutMs: 50 });
    await s.prompt('run it');
    await waitFor(() => existsSync(pidFile), `the command to write its pid to ${pidFile}`);

    // Several idle periods with no turn in flight.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await h.health())['mock']).toBe('ready');
    await s.close();
  }, 30_000);
});

describe('SessionTerminals directly', () => {
  it('narrows a relative cwd and rejects an escaping absolute one', () => {
    const root = scratch();
    mkdirSync(join(root, 'sub'));
    const terminals = new SessionTerminals(root);
    expect(terminals.resolveCwd(undefined)).toBe(root);
    expect(terminals.resolveCwd('sub')).toBe(join(root, 'sub'));
    expect(() => terminals.resolveCwd('../elsewhere')).toThrow(/outside the session/);
    expect(() => terminals.resolveCwd('/etc')).toThrow(/outside the session/);
    // Nothing to contain: the boundary is about a directory that resolves.
    expect(() => terminals.resolveCwd('missing')).toThrow(/does not exist/);
  });

  it('refuses a cwd that leaves the session through a symlink', () => {
    // The lexical check sees a session-relative path; only the resolved one
    // shows the command would have run outside the boundary the host set.
    const root = scratch();
    const outside = scratch();
    symlinkSync(outside, join(root, 'escape'));
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'inside-link'));
    const terminals = new SessionTerminals(root);
    expect(() => terminals.resolveCwd('escape')).toThrow(/outside the session/);
    // A link that stays inside is still inside; the check is about where the
    // path lands, not about links.
    expect(terminals.resolveCwd('inside-link')).toBe(join(root, 'inside-link'));
  });

  it('refuses environment variables that decide which program runs', () => {
    for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_SSH_COMMAND']) {
      expect(() => authorizeTerminalEnv([{ name, value: 'x' }])).toThrow(/may not be set/);
    }
    // Host hygiene the engine spawn already depends on, and the adapter's own
    // additions: an agent may not restore either.
    expect(() => authorizeTerminalEnv([{ name: 'CLAUDECODE', value: '1' }])).toThrow(
      /reserved by the host/,
    );
    expect(() => authorizeTerminalEnv([{ name: 'MOCK_X', value: '1' }], [/^MOCK_/])).toThrow(
      /reserved by the host/,
    );
    expect(() => authorizeTerminalEnv([{ name: 'not a name', value: 'x' }])).toThrow(/invalid environment/);
    expect(() => authorizeTerminalEnv([{ name: 'OK', value: 'a\u0000b' }])).toThrow(/NUL byte/);
    expect(authorizeTerminalEnv([{ name: 'MY_FLAG', value: '1' }])).toEqual([
      { name: 'MY_FLAG', value: '1' },
    ]);
    expect(authorizeTerminalEnv(undefined)).toEqual([]);
  });

  it('flushes a stream that ends mid-character', async () => {
    // Half a UTF-8 sequence at the end of the stream is still output: it has
    // to arrive as a replacement character rather than vanish in the decoder.
    const terminals = new SessionTerminals(scratch());
    const id = terminals.create({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([0x61, 0xe4]))'],
    });
    await terminals.waitForExit(id);
    // Exit precedes the stream's end; the flush happens with the stream.
    for (let i = 0; i < 100 && terminals.output(id).output.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(terminals.output(id).output).toBe('a\ufffd');
    await terminals.releaseAll();
  }, 30_000);

  it('keeps the tail when output exceeds the byte limit', async () => {
    const terminals = new SessionTerminals(scratch());
    const id = terminals.create({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(500) + "TAIL")'],
      outputByteLimit: 64,
    });
    await terminals.waitForExit(id);
    const out = terminals.output(id);
    // Truncation drops the beginning, because the end is what a caller reading
    // a long log actually needs.
    expect(out.truncated).toBe(true);
    expect(out.output.endsWith('TAIL')).toBe(true);
    expect(out.output.length).toBeLessThanOrEqual(64);
    terminals.releaseAll();
  }, 30_000);

  it('keeps multi-byte output intact across chunk boundaries', async () => {
    const terminals = new SessionTerminals(scratch());
    // 40k of a three-byte character: node writes this in several chunks, and a
    // decoder that treats each chunk independently produces replacement
    // characters at every boundary.
    const id = terminals.create({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("界".repeat(40000))'],
      outputByteLimit: 10_000_000,
    });
    await terminals.waitForExit(id);
    const out = terminals.output(id);
    expect(out.output).toHaveLength(40000);
    expect(out.output).not.toContain('\uFFFD');
    terminals.releaseAll();
  }, 30_000);

  it('reports a command that survives being killed instead of dropping it', async () => {
    const terminals = new SessionTerminals(scratch());
    // A process that ignores SIGTERM and cannot be killed is the case worth
    // reporting: the caller closing the session is the last party who could.
    const id = terminals.create({
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    });
    // It does die on SIGKILL, so the release reports success — the assertion
    // that matters is that release() answers at all rather than returning
    // before the process is gone.
    await expect(terminals.release(id)).resolves.toBe(true);
    expect(terminals.hasRunning()).toBe(false);
  }, 30_000);

  it('caps an unreasonable output limit rather than holding whatever is asked for', async () => {
    const terminals = new SessionTerminals(scratch());
    // The limit is the agent's to choose, but it chooses this process's memory.
    const id = terminals.create({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(200000))'],
      outputByteLimit: 8 * 1024 * 1024 * 1024,
    });
    await terminals.waitForExit(id);
    const out = terminals.output(id);
    expect(out.output).toHaveLength(200000);
    expect(out.truncated).toBe(false);
    terminals.releaseAll();
  }, 30_000);

  it('reports a command that cannot start instead of throwing', async () => {
    const terminals = new SessionTerminals(scratch());
    const id = terminals.create({ command: 'definitely-not-a-real-command-xyz' });
    const status = await terminals.waitForExit(id);
    expect(status.exitCode).toBe(127);
    expect(terminals.output(id).output).toMatch(/failed to start/);
    terminals.releaseAll();
  }, 30_000);
});
