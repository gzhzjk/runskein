/**
 * Acceptance cases for the hub, process lifecycle, and error surface:
 * inventory without spawning, process sharing and reaping, crash restart,
 * quit, typed error provenance, and cross-platform spawn behavior.
 *
 * Test-plan cases: HD-08, PM-01, PM-03, PM-04, PM-05, ER-03, OS-01, OS-03.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotInstalledError, UnauthenticatedError } from '../src/errors.js';
import { countSpawns, expectEventually, makeHub, mockAdapter, tmp } from './testkit.js';

describe('A — describe() caching (HD-08)', () => {
  it('describe() is cached within a version; a version bump re-probes', async () => {
    const trace = join(tmp('runskein-hd08-'), 'spawns.log');
    let version = '1.0.0';
    const hub = makeHub({}, {}, [
      {
        ...mockAdapter({ MOCK_TRACE_FILE: trace }),
        detect: async () => ({ installed: true, version }),
      },
    ]);

    await hub.describe('mock');
    await hub.describe('mock');
    expect(countSpawns(trace)).toBe(1); // cache keyed by id@version — no respawn

    // Engine upgraded: the binary is gone and detect now reports 2.0.0.
    // After the discovery refresh the next describe must probe afresh rather
    // than reuse the stale v1.0.0 descriptor.
    version = '2.0.0';
    await hub.quit();
    await hub.rescan();
    await hub.describe('mock');
    expect(countSpawns(trace)).toBe(2);
  });
});

describe('B — process lifecycle at hub level (PM)', () => {
  it('PM-01: createHub spawns nothing; first session() spawns exactly one child', async () => {
    const trace = join(tmp('runskein-pm01-'), 'spawns.log');
    const hub = makeHub({ MOCK_TRACE_FILE: trace });
    expect(countSpawns(trace)).toBe(0);

    const a = await hub.session({ engine: 'mock', cwd: tmp('runskein-pm01-') });
    expect(countSpawns(trace)).toBe(1);

    const b = await hub.session({ engine: 'mock', cwd: tmp('runskein-pm01-') });
    expect(countSpawns(trace)).toBe(1); // shared process (refcounted)

    await a.close();
    await b.close();
  });

  it('PM-03: idle timer never fires while a session is live; reaps after close', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '600' }, { defaults: { idleTimeoutMs: 120 } });
    expect((await hub.health()).mock).toBe('stopped');

    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pm03-') });
    expect((await hub.health()).mock).toBe('ready');

    // A turn lasting well beyond idleTimeoutMs must not be reaped mid-turn.
    const pending = s.prompt('long turn');
    await new Promise((r) => setTimeout(r, 350));
    expect((await hub.health()).mock).toBe('ready');

    await pending;
    await s.close(); // last reference released → idle timer starts
    await expectEventually(async () => (await hub.health()).mock === 'stopped', 3_000);
  });

  it('PM-04: hub.quit(engineId) targets one engine; hub.quit() quits all', async () => {
    const hub = makeHub({}, {}, [mockAdapter({}, 'one'), mockAdapter({}, 'two')]);
    const a = await hub.session({ engine: 'one', cwd: tmp('runskein-pm04-') });
    const b = await hub.session({ engine: 'two', cwd: tmp('runskein-pm04-') });
    expect(await hub.health()).toEqual({ one: 'ready', two: 'ready' });

    await hub.quit('one');
    expect(await hub.health()).toEqual({ one: 'dead', two: 'ready' });

    await hub.quit();
    expect(await hub.health()).toEqual({ one: 'dead', two: 'dead' });

    await a.close();
    await b.close();
  });

  it('PM-05: hub.health() walks stopped → ready → dead', async () => {
    const hub = makeHub();
    expect((await hub.health()).mock).toBe('stopped');

    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pm05-') });
    expect((await hub.health()).mock).toBe('ready');

    await hub.quit();
    expect((await hub.health()).mock).toBe('dead');
    await s.close();
  });

  it('PM-05: crash mid-turn shows degraded, then ready after auto-restart', async () => {
    const hub = makeHub({ MOCK_CRASH_AFTER_MS: '150', MOCK_PROMPT_DELAY_MS: '3000' });
    const restarted = new Promise<void>((res) => {
      const un = hub.on('engine:restarted', () => {
        un();
        res();
      });
    });

    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pm05-') });
    const pending = s.prompt('doomed').then(
      () => null,
      () => null,
    );
    await restarted;
    expect((await hub.health()).mock).toBe('ready');
    await pending;
  });
});

describe('I — error contract, auth (ER-03) + out-of-scope (OS)', () => {
  it('ER-03: unauthenticated engine → UnauthenticatedError with login hint + event', async () => {
    const adapter = {
      ...mockAdapter(),
      detect: async () => ({ installed: true, authenticated: false, loginHint: 'mock acp --login' }),
    };
    const hub = makeHub({}, {}, [adapter]);
    expect((await hub.health()).mock).toBe('unauthenticated');

    const events: string[] = [];
    const un = hub.on('engine:unauthenticated', (info) => events.push(info.engineId));
    const err = await hub.session({ engine: 'mock', cwd: tmp('runskein-er03-') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthenticatedError);
    expect((err as UnauthenticatedError).loginHint).toBe('mock acp --login');
    expect(events).toEqual(['mock']);
    un();
  });

  it('OS-01: probe initialize declines client-side fs/* methods', async () => {
    const record = join(tmp('runskein-os01-'), 'init.json');
    const hub = makeHub({ MOCK_RECORD_INIT_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-os01-') });
    await s.prompt('hi');
    const init = JSON.parse(readFileSync(record, 'utf8')) as {
      params: { clientCapabilities: { fs: Record<string, boolean> } };
    };
    expect(init.params.clientCapabilities.fs).toEqual({
      readTextFile: false,
      writeTextFile: false,
    });
    await s.close();
  });

  it('OS-03: explicit engine selection only — "auto" is NotInstalledError, no spawn', async () => {
    const trace = join(tmp('runskein-os03-'), 'spawns.log');
    const hub = makeHub({ MOCK_TRACE_FILE: trace });
    const err = await hub.session({ engine: 'auto', cwd: tmp('runskein-os03-') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotInstalledError);
    expect((err as NotInstalledError).engineId).toBe('auto');
    expect(countSpawns(trace)).toBe(0);
  });
});
