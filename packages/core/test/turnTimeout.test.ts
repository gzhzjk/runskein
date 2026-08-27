/**
 * Request and turn timeouts (AC-3.2, AC-3.5).
 *
 * Two knobs with deliberately different characters: setup-class requests have
 * always had a 30 s ceiling, while prompts have had none at all — a turn queued
 * behind a slow one on a serializing engine waits forever with no typed error.
 * The fix is not a default ceiling on prompts; a legitimate turn runs for
 * minutes and no measurement supports any particular number. It is that the
 * ceiling exists and is settable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineOperationError } from '../src/errors.js';
import type { EngineCleanupFailure } from '../src/types.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { expectEventually, makeHub, tmp } from './testkit.js';

/** Run an operation and return whatever it rejects with, or null on success. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

/** Count engine-side delete attempts recorded by the mock agent. */
function deleteCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

describe('ST-CONC-03 — requestTimeoutMs bounds setup-class requests (AC-3.2)', () => {
  it('a hub-level ceiling below the engine delay fails the creation as a timeout', async () => {
    const hub = makeHub({ MOCK_NEW_DELAY_MS: '2000' }, { defaults: { requestTimeoutMs: 500 } });
    const error = await rejection(() => hub.session({ engine: 'mock', cwd: tmp('runskein-to-') }));

    expect(error).toBeInstanceOf(EngineOperationError);
    expect((error as EngineOperationError).operation).toBe('session/new');
    expect((error as EngineOperationError).kind).toBe('timeout');
  }, 20_000);

  it('a ceiling above the delay lets the same operation through', async () => {
    // The same slow engine, only the window changed — which is what makes this
    // a test of the knob rather than of the mock.
    const hub = makeHub({ MOCK_NEW_DELAY_MS: '2000' }, { defaults: { requestTimeoutMs: 5_000 } });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });
    expect(session.id).toBeTruthy();
    await session.close();
  }, 20_000);

  it('a per-session ceiling overrides the hub default', async () => {
    const hub = makeHub({ MOCK_NEW_DELAY_MS: '2000' }, { defaults: { requestTimeoutMs: 5_000 } });
    const error = await rejection(() =>
      hub.session({ engine: 'mock', cwd: tmp('runskein-to-'), requestTimeoutMs: 500 }),
    );
    expect((error as EngineOperationError).kind).toBe('timeout');
  }, 20_000);

  it('uses the same ceiling for every resume tier', async () => {
    const stateDir = tmp('runskein-to-resume-');
    const store = join(stateDir, 'store');
    const deletes = join(stateDir, 'deletes.jsonl');
    const seedHub = makeHub({}, { store: jsonlStore(store) });
    const seed = await seedHub.session({ engine: 'mock', cwd: tmp('runskein-to-') });
    await seed.close();
    await seedHub.quit();

    const hub = makeHub(
      {
        MOCK_DELETE: '1',
        MOCK_RECORD_DELETE_FILE: deletes,
        MOCK_RESUME_DELAY_MS: '400',
        MOCK_NEW_DELAY_MS: '400',
      },
      { store: jsonlStore(store), defaults: { requestTimeoutMs: 100 } },
    );
    const error = await rejection(() =>
      hub.session({ engine: 'mock', cwd: tmp('runskein-to-'), resume: seed.id }),
    );
    expect(error).toBeInstanceOf(EngineOperationError);
    expect((error as EngineOperationError).operation).toBe('session/resume');
    expect((error as EngineOperationError).kind).toBe('timeout');
    await hub.quit();
    expect(existsSync(deletes)).toBe(true);
    expect(readFileSync(deletes, 'utf8')).toContain('mock-session-1');
  }, 20_000);

  it('uses the session ceiling for session/fork', async () => {
    const stateDir = tmp('runskein-to-fork-');
    const deletes = join(stateDir, 'deletes.jsonl');
    const hub = makeHub(
      { MOCK_DELETE: '1', MOCK_RECORD_DELETE_FILE: deletes, MOCK_FORK_DELAY_MS: '400' },
      { defaults: { requestTimeoutMs: 5_000 } },
    );
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-'), requestTimeoutMs: 100 });
    const error = await rejection(() => session.fork());
    expect(error).toBeInstanceOf(EngineOperationError);
    expect((error as EngineOperationError).operation).toBe('session/fork');
    expect((error as EngineOperationError).kind).toBe('timeout');
    await hub.quit();
    expect(existsSync(deletes)).toBe(true);
    expect(readFileSync(deletes, 'utf8')).toContain('mock-session-2');
  }, 20_000);
});

describe('ST-CONC-05 — turnTimeoutMs bounds a turn only when set (AC-3.5)', () => {
  it('is unbounded by default: a slow turn is not cut off', async () => {
    // The default path, which is the one a consumer gets without opting in and
    // therefore the one most likely to go untested. A turn far longer than any
    // setup-class ceiling must still complete.
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '1200' });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });
    const turn = await session.prompt('slow but legitimate');
    expect(turn.stopReason).toBe('end_turn');
    await session.close();
  }, 30_000);

  it('a wedged turn rejects with a typed timeout naming the operation', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '5000' }, { defaults: { turnTimeoutMs: 150 } });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });

    const error = await rejection(() => session.prompt('wedged'));
    expect(error).toBeInstanceOf(EngineOperationError);
    expect((error as EngineOperationError).operation).toBe('session/prompt');
    expect((error as EngineOperationError).kind).toBe('timeout');
    await session.close();
  }, 30_000);

  it('a per-session turn ceiling overrides the hub default', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '5000' }, { defaults: { turnTimeoutMs: 60_000 } });
    const session = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-to-'),
      turnTimeoutMs: 150,
    });
    const error = await rejection(() => session.prompt('wedged'));
    expect((error as EngineOperationError).kind).toBe('timeout');
    await session.close();
  }, 30_000);
});

describe('ST-CONC-05 — late settlement preserves the FIFO slot', () => {
  it('keeps the FIFO slot until the original reply lands, so the next prompt cannot overlap', async () => {
    // The engine acknowledges the cancellation but keeps working, which is the
    // case the contract exists for: releasing the slot when the caller is
    // rejected would let the next prompt reach the engine while the abandoned
    // turn is still running.
    const hub = makeHub(
      { MOCK_PROMPT_DELAY_MS: '900', MOCK_PROMPT_DELAY_ONCE: '1', MOCK_IGNORE_CANCEL: '1' },
      { defaults: { turnTimeoutMs: 120 } },
    );
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });

    const first = rejection(() => session.prompt('abandoned'));
    expect(((await first) as EngineOperationError).kind).toBe('timeout');

    // Queued, not rejected: a timeout is not a cancellation of the session.
    const startedAt = Date.now();
    const second = await session.prompt('queued behind it');
    expect(second.stopReason).toBe('end_turn');
    // It could only start once the abandoned turn's reply freed the slot.
    expect(Date.now() - startedAt).toBeGreaterThan(300);
    await session.close();
  }, 30_000);

  it('an explicit cancel() while the slot drains does not reject the queued prompt early', async () => {
    const hub = makeHub(
      { MOCK_PROMPT_DELAY_MS: '700', MOCK_PROMPT_DELAY_ONCE: '1', MOCK_IGNORE_CANCEL: '1' },
      { defaults: { turnTimeoutMs: 120 } },
    );
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });
    await rejection(() => session.prompt('abandoned'));

    // cancel() finds no active turn of its own to stop — the caller of the
    // timed-out one is long gone — so it is a no-op on that draining slot.
    await session.cancel();
    const after = await session.prompt('still works');
    expect(after.stopReason).toBe('end_turn');
    await session.close();
  }, 30_000);
});

describe('ST-CONC-05 — cleanup reporting', () => {
  it('a creation that lands after its timeout is disposed, not left behind', async () => {
    const failures: EngineCleanupFailure[] = [];
    const hub = makeHub({ MOCK_NEW_DELAY_MS: '400' }, { defaults: { requestTimeoutMs: 100 } });
    hub.on('engine:cleanup-failed', (info) => failures.push(info));

    await rejection(() => hub.session({ engine: 'mock', cwd: tmp('runskein-to-') }));
    // quit() waits for the compensation rather than racing it.
    await hub.quit();

    // The mock advertises close but not delete, so the delete leg is reported
    // as un-completed rather than quietly treated as done.
    expect(failures.some((f) => f.operation === 'session/delete')).toBe(true);
    expect(failures.every((f) => typeof f.nativeId === 'string')).toBe(true);
  }, 30_000);

  it('closes and deletes a fork that arrives after the caller times out', async () => {
    const trace = `${tmp('runskein-to-fork-')}/delete.ndjson`;
    const hub = makeHub(
      {
        MOCK_FORK_DELAY_MS: '500',
        MOCK_DELETE: '1',
        MOCK_RECORD_DELETE_FILE: trace,
      },
      { defaults: { requestTimeoutMs: 100 } },
    );
    const parent = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-fork-') });

    const error = await rejection(() => parent.fork());

    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/fork', kind: 'timeout' });
    await expectEventually(() => deleteCount(trace) === 1, 5_000);
    await parent.close();
  }, 30_000);
});

describe('ST-CONC-05 — a request that never settles', () => {
  it('gives up on the drain instead of wedging the session forever', async () => {
    // The engine accepts the prompt and never answers. Waiting for settlement
    // is normally right, but unbounded waiting would hold the FIFO slot for
    // good: every later prompt queues behind it and the session dies quietly,
    // which is the failure this whole capability exists to remove.
    const failures: EngineCleanupFailure[] = [];
    const hub = makeHub(
      { MOCK_NEVER_REPLY_PROMPT: '1' },
      { defaults: { turnTimeoutMs: 100 }, cleanupWindowMs: 300 },
    );
    hub.on('engine:cleanup-failed', (info) => failures.push(info));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });

    const error = await rejection(() => session.prompt('never answered'));
    expect((error as EngineOperationError).kind).toBe('timeout');

    // The unobserved response is reported, never silently treated as finished.
    await expectEventually(
      () => failures.some((f) => f.operation === 'session/prompt' && f.nativeId !== undefined),
      5_000,
    );
    await hub.quit();
  }, 30_000);
});

describe('ST-CONC-05 — a wedged turn hands the session to recovery', () => {
  it('the next prompt rebuilds the session instead of inheriting the dead slot', async () => {
    // Giving up on the drain leaves an abandoned request outstanding on that
    // connection, so the session must not keep using it as if nothing happened.
    // Section 2.2's reactivation is what makes the session usable again.
    const hub = makeHub(
      { MOCK_NEVER_REPLY_PROMPT: '1', MOCK_NEVER_REPLY_ONCE: '1' },
      { defaults: { turnTimeoutMs: 100 }, cleanupWindowMs: 250 },
    );
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });
    const revivals: unknown[] = [];
    session.on('reactivated', (info) => revivals.push(info));

    expect(((await rejection(() => session.prompt('wedged'))) as EngineOperationError).kind).toBe(
      'timeout',
    );

    const recovered = await session.prompt('after the wedge');
    expect(recovered.stopReason).toBe('end_turn');
    expect(revivals).toHaveLength(1); // rebuilt rather than reusing the connection
    await session.close();
  }, 30_000);
});

describe('ST-CONC-05 — a compensation failure is never reported as success', () => {
  it('surfaces a cancellation that could not be delivered', async () => {
    // The shape this codebase keeps inviting: the cancel leg fails, the drain
    // then settles normally, and the whole episode looks clean because the only
    // thing that went wrong resolved to undefined. The failure must have been
    // announced at the point it happened.
    const failures: EngineCleanupFailure[] = [];
    const hub = makeHub(
      { MOCK_PROMPT_DELAY_MS: '600', MOCK_PROMPT_DELAY_ONCE: '1' },
      { defaults: { turnTimeoutMs: 100 } },
    );
    hub.on('engine:cleanup-failed', (info) => failures.push(info));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-to-') });

    // Break the wire underneath the cancellation only.
    const connection = (
      session as unknown as { internals: { acquired: { connection: Record<string, unknown> } } }
    ).internals.acquired.connection;
    const realCancel = connection['cancelSession'] as (id: string) => Promise<void>;
    connection['cancelSession'] = (): Promise<void> =>
      Promise.reject(new Error('cancel could not be delivered'));

    await rejection(() => session.prompt('wedged'));
    connection['cancelSession'] = realCancel;

    await expectEventually(() => failures.some((f) => f.operation === 'session/cancel'), 5_000);
    const reported = failures.find((f) => f.operation === 'session/cancel');
    expect(reported?.sessionId).toBe(session.id);
    expect(reported?.error).toBeInstanceOf(Error);
    await session.close();
  }, 30_000);
});
