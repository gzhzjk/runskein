/**
 * ST-ORPH-03 / ST-ORPH-06 — the sweep that reaps what already leaked
 * (AC-1.3, AC-1.6).
 *
 * The supervisor closes the hole going forward; the sweep is for processes
 * that leaked before it existed, or from a host that died without one. Its
 * whole risk profile is the inverse of the supervisor's: a sweep that reaps
 * too little leaves a process behind, but a sweep that reaps too much kills a
 * *different host's live 1–24 h task*. Every case here is therefore as much
 * about what must survive as about what must die.
 *
 * Planted processes are trees, not bare children: a childless victim would let
 * a reaper that kills a single pid pass while leaving real engine trees — npx
 * → node → engine, deeper for codex — half-alive.
 */
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileOwnershipRegistry,
  sweepOrphans,
  type OrphanSweepResult,
  type OwnershipEntry,
} from '../src/process/ownership.js';
import type { IdleClock } from '../src/session/idleClock.js';
import { FIXTURE, collect, expectEventually, makeHub, tmp } from './testkit.js';
import type { EngineAdapter } from '../src/types.js';

/** A sweep clock whose ticks the test fires, awaiting each run's completion. */
interface FakeSweepClock extends IdleClock {
  fire(): Promise<void>;
}

function fakeSweepClock(): FakeSweepClock {
  let pending: (() => void) | undefined;
  return {
    schedule(_ms: number, fire: () => void): () => void {
      pending = fire;
      return () => {
        pending = undefined;
      };
    },
    async fire(): Promise<void> {
      pending?.();
      // The sweep is async; let its promise chain settle before asserting.
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

/** Everything this file spawned, cleaned up even when a case fails. */
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The elapsed-time-derived start of a live pid, matching what the sweep reads. */
function startedAtOf(pid: number): number {
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,etime='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!m || Number(m[1]) !== pid) continue;
    const parts = m[2]!.split(/[-:]/).map(Number);
    const secs =
      parts.length === 4
        ? parts[0]! * 86400 + parts[1]! * 3600 + parts[2]! * 60 + parts[3]!
        : parts.length === 3
          ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
          : parts[0]! * 60 + parts[1]!;
    return Date.now() - secs * 1000;
  }
  return Date.now();
}

/** A reaper that stops a whole process group, as production does. */
const groupReaper = async (pid: number): Promise<boolean> => {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
};

describe('ST-ORPH-03 — the sweep reaps orphans and spares everything else (AC-1.3)', () => {
  it('reaps an orphan whose owner is dead, and never touches one whose owner lives', async () => {
    const registry = fileOwnershipRegistry(join(tmp('runskein-sweep-'), 'registry.jsonl'));

    // Orphan: a tree whose recorded owner pid is not a live process.
    const orphan = spawn(process.execPath, ['-e', '/*runskein-orphan-victim*/ setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    spawned.push(orphan.pid!);
    // Decoy: identical in every way except that its owner is this very process,
    // which is alive. It stands in for a sibling host's live engine.
    const decoy = spawn(process.execPath, ['-e', '/*runskein-orphan-victim*/ setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    spawned.push(decoy.pid!);
    await new Promise((r) => setTimeout(r, 300));

    // A pid that is certainly dead: spawn and reap something trivial.
    const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadOwner = corpse.pid!;
    await new Promise((r) => corpse.on('exit', r));

    const base = { engineId: 'mock', argv0: 'runskein-orphan-victim' };
    await registry.add({
      ...base,
      enginePid: orphan.pid!,
      ownerPid: deadOwner,
      startedAt: startedAtOf(orphan.pid!),
    } satisfies OwnershipEntry);
    await registry.add({
      ...base,
      enginePid: decoy.pid!,
      ownerPid: process.pid,
      startedAt: startedAtOf(decoy.pid!),
    } satisfies OwnershipEntry);

    const result = await sweepOrphans(registry, groupReaper);
    await new Promise((r) => setTimeout(r, 300));

    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);
    expect(alive(orphan.pid!), 'orphan with a dead owner should have been reaped').toBe(false);
    // The load-bearing half: a live host's engine must survive a sweep it did
    // not ask for. Getting this wrong kills someone else's 24-hour task.
    expect(alive(decoy.pid!), 'engine of a LIVE owner must never be touched').toBe(true);
    // The survivor's record stays, because the process is still ours and alive.
    expect((await registry.list()).map((e) => e.enginePid)).toContain(decoy.pid!);
  }, 30_000);

  it('spares a recycled pid whose start time does not match the record', async () => {
    const registry = fileOwnershipRegistry(join(tmp('runskein-sweep-'), 'registry.jsonl'));
    const victim = spawn(process.execPath, ['-e', '/*runskein-orphan-victim*/ setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    spawned.push(victim.pid!);
    await new Promise((r) => setTimeout(r, 300));

    const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadOwner = corpse.pid!;
    await new Promise((r) => corpse.on('exit', r));

    // Command line matches exactly — which is precisely the trap. Every host
    // running the same engine produces a byte-identical one, so a sweep that
    // trusted the command line alone would kill a stranger's live process.
    // Only the start time distinguishes this pid from the one recorded.
    await registry.add({
      engineId: 'mock',
      argv0: 'runskein-orphan-victim',
      enginePid: victim.pid!,
      ownerPid: deadOwner,
      startedAt: startedAtOf(victim.pid!) - 60 * 60 * 1000,
    } satisfies OwnershipEntry);

    const result = await sweepOrphans(registry, groupReaper);
    await new Promise((r) => setTimeout(r, 300));

    expect(result.reaped).toBe(0);
    expect(alive(victim.pid!), 'a pid whose start time disagrees must not be killed').toBe(true);
  }, 30_000);

  it('does not record a failed kill as reaped, so the entry survives for a retry', async () => {
    const registry = fileOwnershipRegistry(join(tmp('runskein-sweep-'), 'registry.jsonl'));
    const victim = spawn(process.execPath, ['-e', '/*runskein-orphan-victim*/ setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    spawned.push(victim.pid!);
    await new Promise((r) => setTimeout(r, 300));

    const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadOwner = corpse.pid!;
    await new Promise((r) => corpse.on('exit', r));

    await registry.add({
      engineId: 'mock',
      argv0: 'runskein-orphan-victim',
      enginePid: victim.pid!,
      ownerPid: deadOwner,
      startedAt: startedAtOf(victim.pid!),
    } satisfies OwnershipEntry);

    // A reaper that cannot kill. Reporting this as reaped would lose the only
    // record of a process nobody else will ever clean up.
    const result = await sweepOrphans(registry, async () => false);
    expect(result.reaped).toBe(0);
    expect(alive(victim.pid!)).toBe(true);
    expect(
      (await registry.list()).map((e) => e.enginePid),
      'a failed kill must leave the entry for a later sweep',
    ).toContain(victim.pid!);
  }, 30_000);
});

describe('ST-ORPH-06 — the periodic sweep runs, coalesces, and stops (AC-1.6)', () => {
  it('runs once per interval while the hub is live, and never after quit', async () => {
    // The injected clock is what makes "once per interval" assertable without
    // waiting on wall time; the real-timer case below covers the path that
    // actually ships.
    const clock = fakeSweepClock();
    const reports: OrphanSweepResult[] = [];
    const hub = makeHub(
      {},
      {
        orphanSweep: {
          ownership: fileOwnershipRegistry(join(tmp('runskein-sweep-hub-'), 'registry.jsonl')),
          intervalMs: 60_000,
          clock,
          onSweep: (r) => reports.push(r),
        },
      },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sweep-ws-') });
    await s.prompt('hello');

    const before = reports.length;
    await clock.fire();
    expect(reports.length, 'one tick should produce exactly one sweep').toBe(before + 1);
    await clock.fire();
    expect(reports.length).toBe(before + 2);
    // Each report is a real per-run account, not a placeholder.
    for (const r of reports) expect(typeof r.scanned).toBe('number');

    await hub.quit();
    const afterQuit = reports.length;
    await clock.fire();
    expect(reports.length, 'no sweep may run after hub.quit()').toBe(afterQuit);
  }, 30_000);

  it('coalesces overlapping ticks into one run', async () => {
    const clock = fakeSweepClock();
    const reports: OrphanSweepResult[] = [];
    const hub = makeHub(
      {},
      {
        orphanSweep: {
          ownership: fileOwnershipRegistry(join(tmp('runskein-sweep-hub-'), 'registry.jsonl')),
          intervalMs: 60_000,
          clock,
          onSweep: (r) => reports.push(r),
        },
      },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sweep-ws-') });
    await s.prompt('hello');
    reports.length = 0;

    // Fire without awaiting between: a second sweep starting while the first is
    // still running would double the work and could act on stale registry reads.
    await Promise.all([clock.fire(), clock.fire(), clock.fire()]);
    expect(reports.length, 'concurrent ticks must coalesce into one run').toBeLessThanOrEqual(1);
  }, 30_000);

  it('sweeps on the real timer when no clock is injected', async () => {
    // The configuration that actually ships. Testing only the injected clock
    // would leave the default path — the one every real host uses — as the
    // single untested configuration.
    const reports: OrphanSweepResult[] = [];
    const hub = makeHub(
      {},
      {
        orphanSweep: {
          ownership: fileOwnershipRegistry(join(tmp('runskein-sweep-hub-'), 'registry.jsonl')),
          intervalMs: 25,
          onSweep: (r) => reports.push(r),
        },
      },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sweep-ws-') });
    await s.prompt('hello');

    await expectEventually(() => reports.length > 0, 5_000);
    await hub.quit();
    const afterQuit = reports.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(reports.length, 'the real timer must stop at quit too').toBe(afterQuit);
  }, 30_000);
});

describe('ST-ORPH-04 — the supervisor adds no ACP hop (AC-1.4)', () => {
  /**
   * Run a fixed prompt sequence and return its transcript, normalized so only
   * what the protocol produced remains.
   *
   * `ts` and `sessionId` differ per run by construction, and the engine-native
   * session id is assigned fresh each time; `seq` is kept, because ordering and
   * count are exactly what an interposed relay would disturb.
   * @param supervise - whether the adapter declares the watchdog.
   * @param prompts - the turns to run.
   * @returns the normalized transcript as a comparable string.
   */
  async function transcriptFor(supervise: boolean, prompts: string[], cwd: string): Promise<string> {
    const adapter: EngineAdapter = {
      specVersion: 1,
      id: 'mock',
      ...(supervise ? { supervise: true } : {}),
      launch: { command: process.execPath, args: [FIXTURE], startTimeoutMs: 10_000 },
    };
    const hub = makeHub({}, {}, [adapter]);
    // The same workspace for both runs: cwd rides in the session metadata, and
    // a per-run temp dir would show up as a difference that has nothing to do
    // with whether a watchdog sat in the stream.
    const s = await hub.session({ engine: 'mock', cwd });
    for (const prompt of prompts) await s.prompt(prompt);
    const events = await collect(hub.transcripts.get(s.id));
    return JSON.stringify(
      events.map((e) => ({ seq: e.seq, engineId: e.engineId, update: e.update })),
      (key, value) =>
        key === 'nativeSessionId' || key === 'sessionId' || key === 'ts' ? undefined : value,
    );
  }

  it('produces a byte-identical transcript with and without the watchdog', async () => {
    const turns = ['first turn', 'second turn'];
    const cwd = tmp('runskein-orph04-');
    const plain = await transcriptFor(false, turns, cwd);
    const supervised = await transcriptFor(true, turns, cwd);

    expect(plain.length).toBeGreaterThan(0);
    // The watchdog hands the engine its own stdio, so not one protocol byte
    // passes through it. Anything that relayed, buffered, or re-framed the
    // stream would show up here as a different event sequence.
    expect(supervised).toBe(plain);
  }, 60_000);

  it('would notice a stream that actually differed', async () => {
    // Guards the comparison itself: if normalization scrubbed so much that
    // every run looked alike, the assertion above would pass on a supervisor
    // that mangled the stream.
    const cwd = tmp('runskein-orph04-');
    const oneTurn = await transcriptFor(true, ['only turn'], cwd);
    const twoTurns = await transcriptFor(true, ['only turn', 'extra turn'], cwd);
    expect(oneTurn).not.toBe(twoTurns);
  }, 60_000);
});
