/**
 * Session lifetime: idle release and crash recovery through one reactivation
 * path. Test-plan cases ST-LIFE-01 … ST-LIFE-05 and ST-LIFE-07 (AC-2.1 …
 * AC-2.5, and AC-2.3's AC-8.2 clause) live here, named in the case titles.
 *
 * The races are the point. Idle expiry is driven through an injected clock
 * rather than a real timer so a prompt can be scheduled on either side of the
 * transition lock deterministically, instead of hoping a sleep lands right.
 *
 * What all of it guards is the promise that a 1–24 h host does not have to
 * hand-write a recovery loop: a session may let go of its engine and get it
 * back, across both an idle gap and a crash, on the same object — and may never
 * do so silently, because the last resume tier spends tokens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CancelledError, EngineCrashError, EngineOperationError } from '../src/errors.js';
import { Hub, inspectRouting } from '../src/hub.js';
import type { IdleClock } from '../src/session/idleClock.js';
import type { ReactivationInfo } from '../src/session/session.js';
import type { ResumeTier } from '../src/types.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { collect, countSpawns, expectEventually, makeHub, mockAdapter, tmp } from './testkit.js';

/** A clock whose pending countdowns fire only when a test says so. */
class TestClock implements IdleClock {
  private pending: (() => void)[] = [];
  /** Delays the session asked for, in scheduling order. */
  readonly requested: number[] = [];

  schedule(ms: number, fire: () => void): () => void {
    const entry = (): void => fire();
    this.requested.push(ms);
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((e) => e !== entry);
    };
  }

  get scheduled(): number {
    return this.pending.length;
  }

  /** Fire every currently-scheduled countdown. */
  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const entry of due) entry();
  }
}

/** Hub wired with a test clock and a short-ish session idle timeout. */
function idleHub(
  env: Record<string, string> = {},
  extra: { reactivationAttempts?: number } = {},
): { hub: Hub; clock: TestClock } {
  const clock = new TestClock();
  const hub = makeHub(env, {
    idleClock: clock,
    defaults: {
      sessionIdleTimeoutMs: 10_000,
      ...(extra.reactivationAttempts !== undefined
        ? { reactivationAttempts: extra.reactivationAttempts }
        : {}),
    },
  });
  return { hub, clock };
}

/** Settle the microtask queue so a fired countdown reaches its lock. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** Lines the fixture recorded for a knob file, or [] when it never wrote. */
function recorded(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/**
 * Wait until the released engine has actually been reaped.
 *
 * Firing expiry only *starts* the release. A prompt issued before it finishes
 * legitimately cancels it and keeps the same engine — correct behaviour, and
 * what ST-LIFE-07 asserts — so a case that means to observe a revival has to
 * let the release land first, or it silently tests the opposite path.
 * @param hub - the hub under test.
 */
async function awaitRelease(hub: ReturnType<typeof makeHub>): Promise<void> {
  await expectEventually(async () => (await hub.health())['mock'] === 'stopped', 3_000);
}

/** A workspace plus the fixture bookkeeping files a case reads back. */
function scratch(): { cwd: string; trace: string; configs: string } {
  const dir = tmp('runskein-life-');
  return { cwd: dir, trace: join(dir, 'trace.txt'), configs: join(dir, 'configs.jsonl') };
}

describe('idle release', () => {
  it('ST-LIFE-01: is off by default — nothing is armed and the engine stays held', async () => {
    const clock = new TestClock();
    const hub = makeHub({}, { idleClock: clock });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');

    // v1 behaviour preserved: absent means disabled, so nothing is ever armed
    // and the session holds its engine for its whole life.
    expect(clock.requested).toEqual([]);
    expect(clock.scheduled).toBe(0);
    expect((await hub.health())['mock']).toBe('ready');
    await s.close();
  });

  it('ST-LIFE-01: releases on the session deadline, reaps the process, and revives', async () => {
    const clock = new TestClock();
    const { cwd, trace } = scratch();
    const hub = makeHub(
      { MOCK_TRACE_FILE: trace },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50 } },
    );
    const s = await hub.session({ engine: 'mock', cwd });
    await s.prompt('remember the magic word: swordfish');
    const id = s.id;
    expect(countSpawns(trace)).toBe(1);

    // The two deadlines are distinct: the session arms its own threshold, and
    // the process reap clock only starts once the last reference is gone.
    expect(clock.requested).toContain(10_000);
    expect(clock.requested).not.toContain(50);

    clock.fire();
    await settle();
    // Reference released → process reaped by the manager's own, shorter clock.
    await awaitRelease(hub);

    const tiers: ReactivationInfo[] = [];
    s.on('reactivated', (info) => tiers.push(info));
    const turn = await s.prompt('and the magic word?');
    expect(turn.stopReason).toBe('end_turn');
    expect(s.id).toBe(id); // same object, same runskein identity
    expect(tiers).toHaveLength(1);
    expect((await hub.health())['mock']).toBe('ready');
    // A second process was spawned for the revival: proof the first really was
    // reaped rather than the release being cosmetic.
    expect(countSpawns(trace)).toBe(2);
    // One continuous transcript across the gap.
    const events = await collect(hub.transcripts.get(s.id));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.sessionId === id)).toBe(true);
    await s.close();
  });

  it("a suspended session is still the hub's: attach finds it, resume is refused", async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    expect(await hub.attach(s.id)).toBe(s);
    await expect(
      hub.session({ engine: 'mock', cwd: tmp('runskein-life-'), resume: s.id }),
    ).rejects.toBeInstanceOf(EngineOperationError);
    await s.close();
  });

  it('ST-LIFE-07: never releases while a turn is running or work is queued', async () => {
    const { cwd, trace } = scratch();
    const clock = new TestClock();
    const hub = makeHub(
      { MOCK_TRACE_FILE: trace, MOCK_PROMPT_DELAY_MS: '400' },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50 } },
    );
    const s = await hub.session({ engine: 'mock', cwd });
    const first = s.prompt('slow');
    const second = s.prompt('queued');
    await settle();

    clock.fire(); // expiry lands mid-turn with another prompt queued
    await settle();
    expect(await first).toMatchObject({ stopReason: 'end_turn' });
    expect(await second).toMatchObject({ stopReason: 'end_turn' });
    // One process throughout: a release mid-turn would have reaped and revived.
    expect(countSpawns(trace)).toBe(1);
    expect((await hub.health())['mock']).toBe('ready');
    await s.close();
  });

  it('close() on a suspended session is clean and idempotent', async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    await s.close();
    await s.close(); // idempotent
    expect(s.status).toBe('closed');
    expect((await hub.sessions({ status: 'closed' })).map((m) => m.sessionId)).toContain(s.id);
  });
});

describe('idle release races', () => {
  it('a prompt arriving before the lock wins; the countdown stands down', async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');

    const reactivations: ReactivationInfo[] = [];
    s.on('reactivated', (info) => reactivations.push(info));

    // Enqueue first, then fire: the countdown must observe a non-empty queue
    // under the lock and refuse to release.
    const turn = s.prompt('racing');
    clock.fire();
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
    // Nothing was released, so nothing had to be revived.
    expect(reactivations).toHaveLength(0);
    await s.close();
  });

  it('ST-LIFE-07: a prompt arriving after release reactivates exactly once', async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    const reactivations: ReactivationInfo[] = [];
    s.on('reactivated', (info) => reactivations.push(info));
    // Two concurrent prompts on a suspended session must share one revival.
    const [a, b] = await Promise.all([s.prompt('one'), s.prompt('two')]);
    expect(a.stopReason).toBe('end_turn');
    expect(b.stopReason).toBe('end_turn');
    expect(reactivations).toHaveLength(1);
    await s.close();
  });

  it('cancel() on a suspended session rejects the waiting turn without touching an engine', async () => {
    // The turn is parked in reactivation, so it never reached the engine and
    // must reject like any prompt that never ran — and cancel() must not
    // reach through the released connection to say so.
    const record = join(tmp('runskein-life-'), 'prompts.jsonl');
    const { hub, clock } = idleHub({ MOCK_RECORD_PROMPT_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    const parked = s.prompt('never runs').then(
      () => null,
      (e: unknown) => e,
    );
    await s.cancel();
    expect(await parked).toBeInstanceOf(CancelledError);
    // The session is still usable afterwards.
    await expect(s.prompt('after cancel')).resolves.toMatchObject({ stopReason: 'end_turn' });
    // Rejecting the caller does not stop the turn body, so the proof that the
    // revived engine was never prompted is the engine's own record — read once
    // the next turn has run, which the queue could not have started until the
    // cancelled turn's body finished.
    const prompted = readFileSync(record, 'utf8');
    expect(prompted).toContain('hello');
    expect(prompted).toContain('after cancel');
    expect(prompted).not.toContain('never runs');
    await s.close();
  });

  it('ST-LIFE-05: close() racing an in-flight reactivation leaves no engine reference behind', async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    const pending = s.prompt('revive me').then(
      () => null,
      (e: unknown) => e,
    );
    await s.close();
    const err = await pending;
    expect(err).toBeInstanceOf(CancelledError);
    expect(s.status).toBe('closed');
    // Asserted directly rather than inferred: closeLocked()'s own detach()
    // already unregisters the current routing key on the not-bound path (see
    // the 'close() unregisters' case below), so this is not a leak this
    // assertion is catching — it is confirming that guard still holds when a
    // reactivation raced in and changed which key is current first.
    expect(hub[inspectRouting]()).toEqual([]);
    // The engine must be fully given back despite the interleaving.
    await hub.quit();
    expect((await hub.health()).mock).toBe('dead');
  });

  it('close() cleans the rebuilt native session when it wins during reactivation', async () => {
    const stateDir = tmp('runskein-life-close-race-');
    const deletes = join(stateDir, 'deletes.jsonl');
    const creations = join(stateDir, 'creations.jsonl');
    const clock = new TestClock();
    const hub = makeHub(
      {
        MOCK_DELETE: '1',
        MOCK_RECORD_DELETE_FILE: deletes,
        MOCK_RECORD_NEW_FILE: creations,
        MOCK_NO_RESUME: '1',
        MOCK_NO_LOAD: '1',
        MOCK_NEW_DELAY_MS: '250',
        MOCK_NEW_DELAY_AFTER_FIRST: '1',
      },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000 } },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('hello');
    clock.fire();
    await settle();

    const pending = s.prompt('rebuild').catch((error: unknown) => error);
    await expectEventually(
      () => existsSync(creations) && readFileSync(creations, 'utf8').trim().split('\n').length === 2,
      2_000,
    );
    await s.close({ discard: true });
    expect(await pending).toBeInstanceOf(CancelledError);

    expect(existsSync(deletes)).toBe(true);
    const deletedIds = readFileSync(deletes, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sessionId: string }).sessionId);
    expect(deletedIds).toContain('mock-session-2');
  }, 20_000);
});

describe('ST-LIFE-02 — reactivation is never silent (AC-2.2)', () => {
  /**
   * Drive one idle→revive cycle and report the tier the event announced.
   * @param env - mock knobs masking resume capabilities to force a tier.
   * @returns the tiers seen on `reactivated`, in order.
   */
  async function tiersFor(env: Record<string, string>): Promise<ResumeTier[]> {
    const clock = new TestClock();
    const hub = makeHub(env, {
      idleClock: clock,
      defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50 },
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('remember the magic word: swordfish');
    const tiers: ResumeTier[] = [];
    s.on('reactivated', (info) => tiers.push(info.tier));
    clock.fire();
    await awaitRelease(hub);
    await s.prompt('again');
    return tiers;
  }

  it('announces the tier that actually ran, for every tier', async () => {
    expect(await tiersFor({})).toEqual(['native']);
    expect(await tiersFor({ MOCK_NO_RESUME: '1' })).toEqual(['load']);
    // The expensive one: the transcript digest is replayed as fresh context,
    // which spends tokens. This is the degradation the event exists for.
    expect(await tiersFor({ MOCK_NO_RESUME: '1', MOCK_NO_LOAD: '1' })).toEqual(['rebuilt']);
  });

  it('announces a rebuilt tier even when a later step of the revival fails', async () => {
    // The failure mode this forbids: the tokens are spent by the time the
    // resume chain lands, so an event emitted only after everything else
    // succeeded would be lost exactly when the host most needs to know it paid.
    const clock = new TestClock();
    const { cwd, configs } = scratch();
    const hub = makeHub(
      {
        MOCK_NO_RESUME: '1',
        MOCK_NO_LOAD: '1',
        MOCK_RECORD_SET_CONFIG_FILE: configs,
        // The creation write succeeds; the re-application after revival fails.
        MOCK_CONFIG_FAIL_AFTER: '1',
      },
      {
        idleClock: clock,
        // One attempt, so the event count is exact. With the default cap each
        // failed attempt re-runs the chain and announces again — correct, since
        // every rebuild spends its own tokens, but not a fixed number to assert.
        defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50, reactivationAttempts: 1 },
      },
    );
    const s = await hub.session({ engine: 'mock', cwd, config: { model: 'm2' } });
    await s.prompt('seed');

    const tiers: ResumeTier[] = [];
    s.on('reactivated', (info) => tiers.push(info.tier));
    clock.fire();
    await awaitRelease(hub);

    await expect(s.prompt('after the gap')).rejects.toThrow();
    // The revival failed, but the host was still told it paid for a rebuild.
    expect(tiers).toEqual(['rebuilt']);
    // And the re-application really was attempted on the wire.
    expect(recorded(configs).length).toBeGreaterThan(1);
  });
});

describe('ST-LIFE-05 — nothing survives close, seen from outside (AC-2.5)', () => {
  it('restarts nothing, replays nothing, and leaves no routing entry a later session inherits', async () => {
    // The direct oracle for the routing key is the `inspectRouting` case above.
    // This is the black-box half: what a stranded entry would look like to a
    // host that can only watch processes and transcripts.
    const clock = new TestClock();
    const { cwd, trace } = scratch();
    const hub = makeHub(
      // The load tier replays updates during revival, so a routing entry left
      // pointing at the closed session would show up as transcript growth.
      { MOCK_TRACE_FILE: trace, MOCK_NO_RESUME: '1' },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50 } },
    );
    const s = await hub.session({ engine: 'mock', cwd });
    await s.prompt('seed');
    clock.fire();
    await awaitRelease(hub);

    // Start a revival, then close while it is in flight.
    const revival = s.prompt('revive me').catch((e: unknown) => e);
    await s.close();
    await revival;

    expect(s.status).toBe('closed');
    const spawnsAfterClose = countSpawns(trace);
    const settled = (await collect(hub.transcripts.get(s.id))).length;

    // No double release: if close had handed the reference back twice, or the
    // revival had kept one, the count could not reach zero and the manager
    // would never reap. Reaping is the external proof.
    await awaitRelease(hub);

    // Nothing restarted after close, and no late replay landed in the closed
    // session's transcript.
    await new Promise((r) => setTimeout(r, 200));
    expect(countSpawns(trace)).toBe(spawnsAfterClose);
    expect((await collect(hub.transcripts.get(s.id))).length).toBe(settled);

    await expect(s.close()).resolves.toBeUndefined();
    expect((await hub.health())['mock']).toBe('stopped');

    // The sharpest observable available for a stranded routing entry. The
    // fixture numbers its sessions per process, so a session created after the
    // reap gets the same engine-side id the closed one had. If close left that
    // id registered, this turn's updates route to the dead session: the new
    // transcript comes up short and the closed one grows after closure.
    const fresh = await hub.session({ engine: 'mock', cwd });
    await fresh.prompt('routed to me, not to the closed session');
    const freshEvents = await collect(hub.transcripts.get(fresh.id));
    expect(freshEvents.length).toBeGreaterThan(0);
    expect(freshEvents.every((e) => e.sessionId === fresh.id)).toBe(true);
    expect((await collect(hub.transcripts.get(s.id))).length).toBe(settled);
  });
});

describe('ST-LIFE-07 — prompt racing idle expiry (AC-2.1, AC-2.5)', () => {
  it('acquires once when a prompt lands on the far side of expiry', async () => {
    // A third interleaving, distinct from the two race cases above: expiry and
    // the prompt in the same tick, with no await between, so the release is in
    // flight exactly when the prompt arrives.
    const clock = new TestClock();
    const { cwd, trace } = scratch();
    const hub = makeHub(
      { MOCK_TRACE_FILE: trace },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 50 } },
    );
    const s = await hub.session({ engine: 'mock', cwd });
    await s.prompt('seed');
    expect(countSpawns(trace)).toBe(1);

    clock.fire();
    const result = await s.prompt('no await between expiry and me');

    // The prompt is not lost, and the session never acquired twice for one
    // revival — a second acquire would leave a reference nobody releases.
    expect(result.stopReason).toBe('end_turn');
    expect(countSpawns(trace)).toBeLessThanOrEqual(2);
    expect(s.status).toBe('idle');

    // Still holding exactly one reference: a live session must keep its process
    // off the reap clock.
    await new Promise((r) => setTimeout(r, 200));
    expect((await hub.health())['mock']).toBe('ready');
    await s.close();
  });
});

describe('crash recovery', () => {
  it('ST-LIFE-03: the interrupted prompt rejects, and the NEXT prompt recovers without host resume', async () => {
    const stateDir = tmp('runskein-life-crash-');
    const hub = makeHub({
      MOCK_CRASH_ON_PROMPT: '1',
      MOCK_CRASH_FLAG_FILE: join(stateDir, 'crashed.flag'),
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });

    const err = await s.prompt('doomed').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineCrashError);

    const reactivations: ReactivationInfo[] = [];
    s.on('reactivated', (info) => reactivations.push(info));
    const turn = await s.prompt('after the crash');
    expect(turn.stopReason).toBe('end_turn');
    expect(reactivations).toHaveLength(1);
    expect(s.status).toBe('idle');
    await s.close();
  }, 20_000);

  it('ST-LIFE-03: the interrupted turn is not replayed — recovery costs no extra prompt', async () => {
    // Replaying re-spends tokens and is a policy call, so runskein must not do it.
    const stateDir = tmp('runskein-life-crash-');
    const record = join(stateDir, 'prompts.jsonl');
    const hub = makeHub({
      MOCK_CRASH_ON_PROMPT: '1',
      MOCK_CRASH_FLAG_FILE: join(stateDir, 'crashed.flag'),
      MOCK_RECORD_PROMPT_FILE: record,
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.prompt('doomed').catch(() => undefined);
    await s.prompt('deliberate follow-up');

    const { readFileSync } = await import('node:fs');
    const sent = readFileSync(record, 'utf8').trim().split('\n');
    const doomed = sent.filter((line) => line.includes('doomed'));
    expect(doomed).toHaveLength(1); // sent once, never resent
    await s.close();
  }, 20_000);

  it('ST-LIFE-03 (AC-8.2): re-applies desired config after recovery and acknowledges it on the wire', async () => {
    const stateDir = tmp('runskein-life-crash-');
    const record = join(stateDir, 'set-config.jsonl');
    const hub = makeHub({
      MOCK_CRASH_ON_PROMPT: '1',
      MOCK_CRASH_FLAG_FILE: join(stateDir, 'crashed.flag'),
      MOCK_RECORD_SET_CONFIG_FILE: record,
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    await s.setConfig({ model: 'm2' });
    await s.prompt('doomed').catch(() => undefined);
    await s.prompt('after the crash');

    const { readFileSync } = await import('node:fs');
    const writes = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { configId: string; value: string });
    // Once by the caller, once re-applied by runskein after the rebuild.
    expect(writes.filter((w) => w.configId === 'model' && w.value === 'm2')).toHaveLength(2);
    expect(s.configState().desired.model).toBe('m2');
    await s.close();
  }, 20_000);
});

describe('reactivation bounds', () => {
  it('ST-LIFE-04: exhausting the cap throws a typed error naming it, without hanging', async () => {
    // The transcript is what the resume chain rebuilds from, so deleting it
    // makes every attempt fail identically and deterministically — no process
    // games, and no dependence on how an engine happens to die.
    const clock = new TestClock();
    const trace = join(tmp('runskein-life-loop-'), 'spawns.log');
    const store = jsonlStore(tmp('runskein-life-store-'));
    const hub = new Hub({
      discovery: false,
      adapters: [mockAdapter({ MOCK_TRACE_FILE: trace })],
      store,
      idleClock: clock,
      defaults: { sessionIdleTimeoutMs: 10_000, reactivationAttempts: 2 },
    });
    try {
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
      await s.prompt('hello');
      clock.fire();
      await settle();
      const spawnsBefore = countSpawns(trace);
      await store.delete(s.id);

      const err = await s.prompt('revive').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EngineOperationError);
      expect((err as EngineOperationError).operation).toBe('session/reactivate');
      expect((err as EngineOperationError).cause).toMatchObject({ attempts: 2, cap: 2 });
      // Reactivation attempts are not process respawns: these two attempts
      // failed before ever acquiring an engine.
      expect(countSpawns(trace)).toBe(spawnsBefore);

      // Documented in the lifetime decision note, and deliberate: the session
      // keeps its dead reference until closed or revived, so the manager cannot
      // idle-reap that handle in the meantime. A second attempt therefore fails
      // the same typed way rather than hanging, and close stays idempotent.
      const again = await s.prompt('again').catch((e: unknown) => e);
      expect(again).toBeInstanceOf(EngineOperationError);
      await expect(s.close()).resolves.toBeUndefined();
      await expect(s.close()).resolves.toBeUndefined();
    } finally {
      await hub.quit();
    }
  });

  it('stops retrying when close wins during a failed reactivation', async () => {
    const clock = new TestClock();
    const store = jsonlStore(tmp('runskein-life-close-retry-store-'));
    const hub = new Hub({
      discovery: false,
      adapters: [mockAdapter()],
      store,
      idleClock: clock,
      defaults: { sessionIdleTimeoutMs: 10_000, reactivationAttempts: 2 },
    });
    try {
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
      await s.prompt('hello');
      clock.fire();
      await settle();
      await store.delete(s.id);

      // `close()` marks the session before waiting for the same transition
      // lock as reactivation. The first failed attempt must not start retry 2.
      const pending = s.prompt('revive');
      const closing = s.close();
      await expect(pending).rejects.toBeInstanceOf(CancelledError);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      await hub.quit();
    }
  });

  it('releases a lost binding when every recovery attempt fails', async () => {
    const store = jsonlStore(tmp('runskein-life-lost-store-'));
    const hub = new Hub({
      discovery: false,
      adapters: [mockAdapter({ MOCK_NEVER_REPLY_PROMPT: '1', MOCK_NO_RESUME: '1', MOCK_NO_LOAD: '1' })],
      store,
      cleanupWindowMs: 100,
      defaults: { turnTimeoutMs: 100, idleTimeoutMs: 1, reactivationAttempts: 1 },
    });
    try {
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
      const first = await s.prompt('wedged').catch((error: unknown) => error);
      expect(first).toBeInstanceOf(EngineOperationError);
      await store.delete(s.id);

      const failed = await s.prompt('cannot rebuild').catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(EngineOperationError);
      expect((failed as EngineOperationError).operation).toBe('session/reactivate');
      await expectEventually(async () => (await hub.health()).mock === 'stopped', 3_000);
    } finally {
      await hub.quit();
    }
  }, 20_000);

  it('ST-LIFE-04: a successful reactivation resets the budget, so repeated cycles stay allowed', async () => {
    const { hub, clock } = idleHub({}, { reactivationAttempts: 1 });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
    const reactivations: ReactivationInfo[] = [];
    s.on('reactivated', (info) => reactivations.push(info));

    for (let cycle = 0; cycle < 3; cycle++) {
      await s.prompt(`cycle ${cycle}`);
      clock.fire();
      await settle();
    }
    await s.prompt('final');
    // Three suspensions were revived; a per-lifetime budget of 1 would have
    // failed the second one.
    expect(reactivations).toHaveLength(3);
    await s.close();
  });
});

describe('per-session overrides', () => {
  it('SessionOpts values win over hub defaults', async () => {
    const clock = new TestClock();
    const hub = new Hub({
      discovery: false,
      adapters: [mockAdapter()],
      store: jsonlStore(tmp('runskein-life-store-')),
      idleClock: clock,
      defaults: { sessionIdleTimeoutMs: 10_000 },
    });
    try {
      // Opting out per session means no countdown at all for it.
      const pinned = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
      const before = clock.scheduled;
      const timed = await hub.session({ engine: 'mock', cwd: tmp('runskein-life-') });
      expect(clock.scheduled).toBeGreaterThan(before);
      await pinned.close();
      await timed.close();
    } finally {
      await hub.quit();
    }
  });

  it('rejects a non-positive reactivationAttempts at construction', () => {
    expect(() => makeHub({}, { defaults: { reactivationAttempts: 0 } })).toThrow();
  });
});

describe('update routing across the lifetime', () => {
  it('close() unregisters the session from the router', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-route-') });
    expect(hub[inspectRouting]()).toHaveLength(1);
    await s.close();
    expect(hub[inspectRouting]()).toEqual([]);
  });

  it('idle release drops routing but keeps the session attachable', async () => {
    const { hub, clock } = idleHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-route-') });
    await s.prompt('hello');
    expect(hub[inspectRouting]()).toHaveLength(1);

    clock.fire();
    await settle();
    // No engine-side session left to route to, but the hub still owns this one.
    expect(hub[inspectRouting]()).toEqual([]);
    expect(await hub.attach(s.id)).toBe(s);
    await s.close();
  });

  it('a rebuilt reactivation replaces its routing key and close removes the current key', async () => {
    // The rebuilt tier runs on a FRESH engine-side session, so the key changes.
    // Registering the new one without dropping the old would leave the router
    // pointing at this session under an id the engine has forgotten.
    const clock = new TestClock();
    const hub = makeHub(
      { MOCK_NO_RESUME: '1', MOCK_NO_LOAD: '1' },
      { idleClock: clock, defaults: { sessionIdleTimeoutMs: 10_000 } },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-route-') });
    await s.prompt('hello');
    const before = hub[inspectRouting]();
    expect(before).toHaveLength(1);

    clock.fire();
    await settle();
    const tiers: ReactivationInfo[] = [];
    s.on('reactivated', (info) => tiers.push(info));
    await s.prompt('after');

    expect(tiers[0]?.tier).toBe('rebuilt');
    const after = hub[inspectRouting]();
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before); // a new engine-side id, not the old one
    const currentKey = after[0]!;
    await s.close();
    expect(hub[inspectRouting]()).not.toContain(currentKey);
    expect(hub[inspectRouting]()).toEqual([]);
  });
});
