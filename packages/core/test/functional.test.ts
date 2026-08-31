/**
 * Functional tests — ProcessManager, AcpConnection, and Hub driven against
 * the scripted mock agent fixture, so no real engine or auth is involved.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from '../src/process/manager.js';
import { Hub } from '../src/hub.js';
import { EngineOperationError, EngineStartError, NotFoundError, NotInstalledError } from '../src/errors.js';
import type { EngineCrashInfo } from '../src/types.js';
import type { SessionUpdateNotification } from '../src/acp/clientMethods.js';
import { FIXTURE, mockAdapter, tmp } from './testkit.js';

// Cleanup stays local: this suite owns bare ProcessManagers as well as hubs,
// and both have to be torn down in the same pass.
const managers: ProcessManager[] = [];
const hubs: Hub[] = [];
function track<T extends ProcessManager | Hub>(x: T): T {
  (x instanceof Hub ? hubs : managers).push(x as never);
  return x;
}

afterEach(async () => {
  await Promise.all([...managers.splice(0).map((m) => m.quit()), ...hubs.splice(0).map((h) => h.quit())]);
});

// ── ProcessManager ─────────────────────────────────────────────────────────

describe('ProcessManager lifecycle', () => {
  it('spawns on demand, initializes, shares the process, reaps when idle', async () => {
    const manager = track(new ProcessManager({ idleTimeoutMs: 120 }));
    expect(manager.healthOf('mock')).toBe('stopped');

    const a = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-t-') });
    expect(manager.healthOf('mock')).toBe('ready');
    expect(a.connection.initializeResult?.protocolVersion).toBe(1);
    expect(a.connection.capabilities.session['resume']).toBe(true);

    // Second acquire shares the same process/connection (refcount).
    const b = await manager.acquire(mockAdapter());
    expect(b.connection).toBe(a.connection);

    // One release keeps it alive; the idle timer must not run while held.
    a.release();
    await new Promise((r) => setTimeout(r, 250));
    expect(manager.healthOf('mock')).toBe('ready');

    // Last release starts the idle timer → graceful reap → 'stopped'.
    b.release();
    await expectEventually(() => manager.healthOf('mock') === 'stopped', 3_000);
  });

  it('release is idempotent per acquisition', async () => {
    const manager = track(new ProcessManager({ idleTimeoutMs: 60_000 }));
    const a = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-t-') });
    const b = await manager.acquire(mockAdapter());
    a.release();
    a.release(); // double release must not steal b's reference
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.healthOf('mock')).toBe('ready');
    b.release();
  });

  it.skipIf(process.platform === 'win32')(
    'quit waits for and force-kills stubborn process-group descendants',
    async () => {
      const manager = track(new ProcessManager({ idleTimeoutMs: 60_000 }));
      const pidFile = join(tmp('runskein-t-'), 'child.pid');
      const acquired = await manager.acquire(mockAdapter({ MOCK_STUBBORN_CHILD_PID_FILE: pidFile }), {
        cwd: tmp('runskein-t-'),
      });
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      acquired.release();
      await manager.quit('mock', { timeoutMs: 100 });
      expect(() => process.kill(descendantPid, 0)).toThrow();
    },
  );

  it('startup failure is an EngineStartError with stage + cause, engine goes dead', async () => {
    const manager = track(new ProcessManager());
    const failure = await manager
      .acquire(mockAdapter({ MOCK_EXIT_BEFORE_INIT: '1' }), { cwd: tmp('runskein-t-') })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(EngineStartError);
    expect(failure).toMatchObject({ engineId: 'mock', stage: 'spawn' });
    expect(((failure as EngineStartError).cause as Error).message).toMatch(/exited during startup/);
    expect(manager.healthOf('mock')).toBe('dead');
    // dead → starting: a later acquire retries from scratch.
    const ok = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-t-') });
    expect(manager.healthOf('mock')).toBe('ready');
    ok.release();
  });

  it('crash while held: engine:crash → backoff restart → engine:restarted', async () => {
    const manager = track(new ProcessManager({ sleep: () => Promise.resolve() }));
    const crashes: EngineCrashInfo[] = [];
    const restarted = new Promise<void>((res) => {
      manager.on('engine:restarted', () => res());
    });
    manager.on('engine:crash', (info) => crashes.push(info));

    const stateDir = tmp('runskein-crash-');
    const flag = join(stateDir, 'crashed.flag');
    const cwdTrace = join(stateDir, 'cwd.log');
    const launchCwd = tmp('runskein-launch-cwd-');
    const held = await manager.acquire(
      mockAdapter({
        MOCK_CRASH_AFTER_MS: '100',
        MOCK_CRASH_FLAG_FILE: flag,
        MOCK_CWD_TRACE_FILE: cwdTrace,
      }),
      { cwd: launchCwd },
    );
    await restarted;
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({ engineId: 'mock', restarting: true });
    expect(crashes[0]!.detail).toMatch(/exit code 7/);
    await expectEventually(() => manager.healthOf('mock') === 'ready', 3_000);
    const actualCwds = readFileSync(cwdTrace, 'utf8').trim().split('\n');
    expect(actualCwds).toEqual([realpathSync(launchCwd), realpathSync(launchCwd)]);

    // The restarted process serves new work.
    const fresh = await manager.acquire(mockAdapter());
    const sess = await fresh.connection.newSession({ cwd: tmp('runskein-t-') });
    expect(sess.sessionId).toBe('mock-session-1');
    fresh.release();
    held.release();
  });

  it('quit runs the graceful chain and marks the engine dead', async () => {
    const manager = track(new ProcessManager());
    const a = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-t-') });
    a.release();
    await manager.quit('mock');
    expect(manager.healthOf('mock')).toBe('dead');
    // quit is terminal until the next acquire
    const again = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-t-') });
    expect(manager.healthOf('mock')).toBe('ready');
    again.release();
  });
});

describe('detect failure visibility', () => {
  it('failure-isolates inventory but rejects targeted use with the typed cause', async () => {
    const adapter = {
      ...mockAdapter(),
      detect: async () => {
        throw new Error('probe permission denied');
      },
    };
    const hub = track(new Hub({ discovery: false, adapters: [adapter] }));
    expect(await hub.engines()).toMatchObject([
      {
        id: 'mock',
        installed: false,
        health: 'invalid',
        error: expect.stringContaining('probe permission denied'),
      },
    ]);
    await expect(hub.session({ engine: 'mock', cwd: tmp('runskein-detect-') })).rejects.toBeInstanceOf(
      EngineOperationError,
    );
  });
});

// ── AcpConnection round trips ──────────────────────────────────────────────

describe('AcpConnection over the mock agent', () => {
  it('prompt streams updates and answers permission requests', async () => {
    const updates: SessionUpdateNotification[] = [];
    let permissions = 0;
    const manager = track(
      new ProcessManager({
        handlers: {
          onUpdate: (n) => updates.push(n),
          onPermissionRequest: (params) => {
            permissions++;
            return { outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } };
          },
        },
      }),
    );
    const a = await manager.acquire(mockAdapter({ MOCK_ASK_PERMISSION: '1' }), {
      cwd: tmp('runskein-t-'),
    });
    const sess = await a.connection.newSession({ cwd: tmp('runskein-t-') });
    const result = await a.connection.prompt({
      sessionId: sess.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(permissions).toBe(1);
    expect(updates.some((u) => u.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    a.release();
  });

  it('env hygiene: the adapter declares the marker, and the spawn removes it', async () => {
    // The fixture refuses initialize when it sees the marker var. Core scrubs
    // nothing of its own (decision 045), so what must remove it is the pattern
    // this adapter declares — which is why the adapter carries one here and
    // why the case below, without it, must fail.
    process.env['MOCKAGENT_SESSION_TEST_MARKER'] = 'leaky';
    try {
      const manager = track(new ProcessManager());
      const refusing = mockAdapter({ MOCK_REFUSE_ENV: 'MOCKAGENT_SESSION_TEST_MARKER' });
      const a = await manager.acquire(
        { ...refusing, envScrubExtra: [/^MOCKAGENT_SESSION_/] },
        { cwd: tmp('runskein-t-') },
      );
      // Reaching here proves the marker was scrubbed before spawn.
      expect(a.connection.initializeResult?.protocolVersion).toBe(1);
      a.release();

      // The other half: an undeclared marker reaches the child, which is the
      // narrowing decision 045 chose. Without this, the case above would still
      // pass if an engine name were written back into core's list.
      await expect(
        manager.acquire({ ...refusing, id: 'mock-undeclared' }, { cwd: tmp('runskein-t-') }),
      ).rejects.toThrow(/active session/);
    } finally {
      delete process.env['MOCKAGENT_SESSION_TEST_MARKER'];
    }
  });
});

// ── Hub ────────────────────────────────────────────────────────────────────

describe('Hub (M1 surface)', () => {
  it('engines() reports detect results without spawning', async () => {
    const hub = track(
      new Hub({
        discovery: false,
        adapters: [
          {
            ...mockAdapter({}, 'present'),
            detect: async () => ({ installed: true, version: '9.9.9', authenticated: true }),
          },
          {
            ...mockAdapter({}, 'missing'),
            detect: async () => ({ installed: false, loginHint: 'install me' }),
          },
          {
            ...mockAdapter({}, 'locked'),
            detect: async () => ({ installed: true, authenticated: false }),
          },
        ],
      }),
    );
    const engines = await hub.engines();
    const byId = Object.fromEntries(engines.map((e) => [e.id, e]));
    expect(byId['present']).toMatchObject({
      installed: true,
      version: '9.9.9',
      health: 'stopped',
    });
    expect(byId['missing']).toMatchObject({ installed: false, health: 'not-installed' });
    expect(byId['locked']).toMatchObject({ health: 'unauthenticated' });
    expect(await hub.health()).toMatchObject({
      present: 'stopped',
      missing: 'not-installed',
      locked: 'unauthenticated',
    });
  });

  it('describe() probes live: capabilities, modes, configOptions, source=probe', async () => {
    const hub = track(new Hub({ discovery: false, adapters: [mockAdapter()] }));
    const d = await hub.describe('mock');
    expect(d.source).toBe('probe');
    expect(d.capabilities.loadSession).toBe(true);
    expect(d.modes?.map((m) => m.id)).toEqual(['default', 'plan']);
    expect(d.configOptions[0]).toMatchObject({ id: 'model', category: 'model', type: 'select' });
  });

  it('describe() falls back to configHints with source=hints', async () => {
    const hub = track(
      new Hub({
        discovery: false,
        adapters: [
          {
            ...mockAdapter({ MOCK_NO_CONFIG: '1' }),
            configHints: [{ id: 'model', name: 'Model (hint)', type: 'select' }],
          },
        ],
      }),
    );
    const d = await hub.describe('mock');
    expect(d.source).toBe('hints');
    expect(d.configOptions[0]?.name).toBe('Model (hint)');
  });

  it('describe() of an unknown engine is a NotInstalledError', async () => {
    const hub = track(new Hub({ discovery: false, adapters: [] }));
    await expect(hub.describe('nope')).rejects.toThrow(NotInstalledError);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function expectEventually(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(cond()).toBe(true);
}
