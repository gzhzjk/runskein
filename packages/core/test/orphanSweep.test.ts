/**
 * Orphan reaping: the ownership registry, the sweep's kill conditions, and the
 * periodic schedule.
 *
 * Every process assertion here is scoped to a pid this file spawned. A global
 * process query would be both wrong (it could match a sibling worktree's
 * engines) and flaky under the concurrent load this repo actually runs under.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileOwnershipRegistry,
  identityMatches,
  isPidAlive,
  readProcessInfo,
  START_TIME_TOLERANCE_MS,
  sweepOrphans,
  type OrphanSweepResult,
  type OwnershipEntry,
  migrateLegacyRegistry,
} from '../src/process/ownership.js';
import { stopTreeByPid } from '../src/process/spawn.js';
import type { IdleClock } from '../src/session/idleClock.js';
import { ProcessManager } from '../src/process/manager.js';
import { RUNSKEIN_SESSION_META_KEY, type TranscriptEvent } from '../src/transcript/event.js';
import { makeHub, mockAdapter, tmp } from './testkit.js';

const spawned: ChildProcess[] = [];

/**
 * Start a long-lived process this test owns, so assertions can name its pid.
 * @param tag - a distinctive argv fragment used as the launch signature.
 * @returns the child process.
 */
function plantProcess(tag: string): ChildProcess {
  // The planted process spawns a child of its own, because a real engine tree
  // has one — `npx -y <pkg>` puts the process that matters one level down. A
  // childless stand-in cannot tell a reaper that signals the process GROUP from
  // one that signals only the leader, so it would pass either way while the
  // real descendant survived.
  const script =
    `/*${tag}*/ ` +
    `require('child_process').spawn(process.execPath, ['-e', '/*${tag}-child*/ setInterval(()=>{},1000)'], {stdio:'ignore'}); ` +
    `setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  spawned.push(child);
  return child;
}

/**
 * Wait until `ps` can see a planted process as the thing that was planted.
 *
 * `spawn` returns a pid before the child has finished replacing itself with the
 * program, and until it has, `ps` reports the command line it was forked from —
 * which does not carry the tag. Anything that asks about identity in that window
 * gets `mismatch` for a process that is exactly what it says it is.
 *
 * How wide the window is, measured: on an idle machine it closes before a single
 * read, 40 of 40 immediate reads matching on Linux and on macOS. **That it is
 * what a CI runner hit is not established** — the failure there reported a
 * count and no evidence, which is why the assertion below now reports the
 * branch it took. This closes a race that is real whether or not it was that
 * one.
 *
 * Waiting here does not weaken any case: no test in this file is about how soon
 * a process becomes observable, and every one of them is about what happens
 * once it is.
 *
 * @param child - the planted process.
 * @param tag - the marker its command line carries.
 * @throws `Error` naming what `ps` last reported, when the window never closes.
 */
async function awaitInspectable(child: ChildProcess, tag: string): Promise<void> {
  const pid = child.pid!;
  const deadline = Date.now() + 10_000;
  let last: string | undefined = '<never read>';
  while (Date.now() < deadline) {
    const info = await readProcessInfo(pid);
    if (info?.command.includes(tag) === true) return;
    last = info === undefined ? '<ps returned nothing>' : info.command;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `planted process ${String(pid)} never became inspectable as ${tag}; ps last reported ${JSON.stringify(last)}`,
  );
}

/**
 * Every live descendant of a pid this file planted.
 *
 * Deliberately a tree walk from a known pid rather than a search for a tag in
 * the global process list: a name scan also matches leftovers from earlier runs
 * and other worktrees, which is the habit that makes process assertions flaky.
 * @param pid - the root process id.
 * @returns the descendant pids, nearest first.
 */
function descendantsOf(pid: number): number[] {
  // -A because planted processes are detached and belong to no terminal.
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='])
    .toString()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]) }));
  const found: number[] = [];
  let frontier = [pid];
  while (frontier.length > 0) {
    const next = rows.filter((r) => frontier.includes(r.ppid)).map((r) => r.pid);
    found.push(...next);
    frontier = next;
  }
  return found;
}

/**
 * Process groups no host owns: `spawnEngine` detaches the engine into its own
 * group, so killing a sacrificial host's group leaves the engine behind. A test
 * that fails before it can reap one would otherwise leak it for the rest of the
 * run — the fake engine ignores stdin EOF on purpose.
 */
const orphanedGroups: number[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const pid of orphanedGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** Wait for a condition, polling; scoped to short local waits only. */
async function until(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const registryPath = (): string => join(mkdtempSync(join(tmpdir(), 'runskein-own-')), 'engines.jsonl');

describe('ownership registry', () => {
  it('round-trips entries and forgets one without disturbing the others', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const entry = (enginePid: number): OwnershipEntry => ({
      enginePid,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'node',
      startedAt: 1,
    });
    await registry.add(entry(101));
    await registry.add(entry(102));
    await registry.remove(101);

    expect((await registry.list()).map((e) => e.enginePid)).toEqual([102]);
  });

  it('survives a torn line from a concurrent append', async () => {
    const path = registryPath();
    const registry = fileOwnershipRegistry(path);
    await registry.add({
      enginePid: 1,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'node',
      startedAt: 1,
    });
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"enginePid":2,"engi`, 'utf8');

    // The complete record is still readable; the half-written one is skipped
    // rather than taken as a record to act on.
    expect((await registry.list()).map((e) => e.enginePid)).toEqual([1]);
  });

  it('keeps another host’s entries when compacting', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    await registry.add({
      enginePid: 11,
      engineId: 'mock',
      ownerPid: 999_001,
      argv0: 'node',
      startedAt: 1,
    });
    await registry.add({
      enginePid: 12,
      engineId: 'mock',
      ownerPid: 999_002,
      argv0: 'node',
      startedAt: 1,
    });
    await registry.compact([11]);
    expect((await registry.list()).map((e) => e.ownerPid)).toEqual([999_002]);
  });

  it('loses no removal when every engine exits in the same tick', async () => {
    // The shape of `hub.quit()`: each child's exit listener calls remove() with
    // no ordering between them. Compaction is read-modify-write, so unserialized
    // runs each drop only their own pid and the last rename discards the rest —
    // and a temporary name built from pid+millisecond collides outright, making
    // one writer rename a file another had already moved.
    const path = registryPath();
    const registry = fileOwnershipRegistry(path);
    const doomed = [201, 202, 203, 204, 205];
    for (const enginePid of [...doomed, 299]) {
      await registry.add({
        enginePid,
        engineId: 'mock',
        ownerPid: process.pid,
        argv0: 'node',
        startedAt: 1,
      });
    }

    // Fired without awaiting in between, so they interleave inside one tick.
    await Promise.all(doomed.map((enginePid) => registry.remove(enginePid)));

    expect((await registry.list()).map((e) => e.enginePid)).toEqual([299]);
    // A failed rename leaves its scratch file behind; nothing but the registry
    // itself may remain.
    expect(readdirSync(dirname(path))).toEqual(['engines.jsonl']);
  });

  it('loses no removal when two instances on one path compact at once', async () => {
    // Two hubs in one host is ordinary, and each builds its own registry object
    // over the same file. Serialization and scratch-file naming therefore cannot
    // be per-instance: pid and millisecond are identical across them.
    const path = registryPath();
    const first = fileOwnershipRegistry(path);
    const second = fileOwnershipRegistry(path);
    for (const enginePid of [301, 302, 399]) {
      await first.add({
        enginePid,
        engineId: 'mock',
        ownerPid: process.pid,
        argv0: 'node',
        startedAt: 1,
      });
    }

    await Promise.all([first.remove(301), second.remove(302)]);

    expect((await second.list()).map((e) => e.enginePid)).toEqual([399]);
    expect(readdirSync(dirname(path))).toEqual(['engines.jsonl']);
  });
});

describe('sweep kill conditions', () => {
  it('reaps a planted orphan and spares an identical process whose owner is alive', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const orphan = plantProcess('runskein-orphan-victim');
    const sibling = plantProcess('runskein-orphan-sibling');
    await awaitInspectable(orphan, 'runskein-orphan-victim');
    await awaitInspectable(sibling, 'runskein-orphan-sibling');
    // A pid that is certainly not running stands in for the dead host.
    const deadOwner = 999_999;
    expect(isPidAlive(deadOwner)).toBe(false);

    await registry.add({
      enginePid: orphan.pid!,
      engineId: 'mock',
      ownerPid: deadOwner,
      argv0: 'runskein-orphan-victim',
      startedAt: Date.now(),
    });
    await registry.add({
      enginePid: sibling.pid!,
      engineId: 'mock',
      ownerPid: process.pid, // this test process is a live owner
      argv0: 'runskein-orphan-sibling',
      startedAt: Date.now(),
    });

    // The planted process needs a moment to start and spawn its own child.
    expect(await until(() => descendantsOf(orphan.pid!).length === 1)).toBe(true);
    const victimTree = descendantsOf(orphan.pid!);

    const reaped: number[] = [];
    // The production reaper, not a stand-in: this is the code that decides
    // whether a descendant survives.
    const result = await sweepOrphans(registry, async (pid) => {
      reaped.push(pid);
      return stopTreeByPid(pid, 1_000);
    });

    expect(reaped).toEqual([orphan.pid]);
    expect(result).toMatchObject({ scanned: 2, reaped: 1, prunedStaleEntries: 0 });
    expect(await until(() => !isPidAlive(orphan.pid!))).toBe(true);
    // The whole tree, not just the leader: a reaper that signalled only the
    // recorded pid would leave this child running.
    expect(await until(() => victimTree.every((p) => !isPidAlive(p)))).toBe(true);
    // The live owner's process is untouched, which is the half that matters.
    expect(isPidAlive(sibling.pid!)).toBe(true);
    expect(descendantsOf(sibling.pid!).every((p) => isPidAlive(p))).toBe(true);
    // The spared entry stays on file; only the reaped one is forgotten.
    expect((await registry.list()).map((e) => e.enginePid)).toEqual([sibling.pid]);
  });

  it('prunes an entry whose process is already gone, without killing anything', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const dead = plantProcess('runskein-orphan-gone');
    await awaitInspectable(dead, 'runskein-orphan-gone');
    const pid = dead.pid!;
    process.kill(-pid, 'SIGKILL');
    expect(await until(() => !isPidAlive(pid))).toBe(true);

    await registry.add({
      enginePid: pid,
      engineId: 'mock',
      ownerPid: 999_999,
      argv0: 'runskein-orphan-gone',
      startedAt: 1,
    });
    const reaped: number[] = [];
    const result = await sweepOrphans(registry, async (p) => {
      reaped.push(p);
      return true;
    });

    expect(reaped).toEqual([]);
    expect(result).toMatchObject({ scanned: 1, reaped: 0, prunedStaleEntries: 1 });
    expect(await registry.list()).toEqual([]);
  });

  it('refuses to kill a reused pid whose signature no longer matches', async () => {
    // Same shape as a real orphan except the recorded command is not what is
    // running now — which is exactly what pid reuse looks like.
    const registry = fileOwnershipRegistry(registryPath());
    const stranger = plantProcess('runskein-orphan-stranger');
    await awaitInspectable(stranger, 'runskein-orphan-stranger');
    await registry.add({
      enginePid: stranger.pid!,
      engineId: 'mock',
      ownerPid: 999_999,
      argv0: 'a-command-this-process-was-never-launched-with',
      startedAt: 1,
    });

    const reaped: number[] = [];
    const result = await sweepOrphans(registry, async (p) => {
      reaped.push(p);
      return true;
    });

    expect(reaped).toEqual([]);
    expect(result).toMatchObject({ reaped: 0, prunedStaleEntries: 1 });
    expect(isPidAlive(stranger.pid!)).toBe(true);
  });
});

/** A clock whose scheduled ticks fire only when a test says so. */
class TestClock implements IdleClock {
  private pending: (() => void)[] = [];

  schedule(_ms: number, fire: () => void): () => void {
    const entry = (): void => fire();
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((e) => e !== entry);
    };
  }

  get scheduled(): number {
    return this.pending.length;
  }

  fire(): void {
    for (const entry of this.pending.splice(0)) entry();
  }
}

describe('periodic sweep', () => {
  it('sweeps before the first acquire, once per interval, and stops after quit', async () => {
    const clock = new TestClock();
    const runs: OrphanSweepResult[] = [];
    const manager = new ProcessManager({
      ownership: fileOwnershipRegistry(registryPath()),
      sweepClock: clock,
      onSweep: (result) => runs.push(result),
    });
    try {
      const held = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-own-') });
      expect(runs).toHaveLength(1); // ran before the engine started
      expect(clock.scheduled).toBe(1); // and armed the next one

      clock.fire();
      await until(() => runs.length === 2);
      expect(runs).toHaveLength(2);

      held.release();
      await manager.quit();
      const afterQuit = runs.length;
      clock.fire(); // any timer that survived would fire here
      await new Promise((r) => setTimeout(r, 50));
      expect(runs).toHaveLength(afterQuit);
      expect(clock.scheduled).toBe(0);
    } finally {
      await manager.quit().catch(() => undefined);
    }
  });

  it('coalesces overlapping ticks into one run', async () => {
    const clock = new TestClock();
    let inFlight = 0;
    let maxConcurrent = 0;
    const runs: OrphanSweepResult[] = [];
    // A registry whose read is slow enough that a second tick lands inside it.
    const slowRegistry = {
      ...fileOwnershipRegistry(registryPath()),
      async list() {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return [];
      },
    };
    const manager = new ProcessManager({
      ownership: slowRegistry,
      sweepClock: clock,
      onSweep: (result) => runs.push(result),
    });
    try {
      const held = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-own-') });
      const before = runs.length;
      clock.fire();
      clock.fire();
      clock.fire();
      await until(() => runs.length > before);
      await new Promise((r) => setTimeout(r, 120));
      expect(maxConcurrent).toBe(1); // never two sweeps at once
      held.release();
    } finally {
      await manager.quit().catch(() => undefined);
    }
  });

  it('records a spawned engine and forgets it when the process exits', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const manager = new ProcessManager({
      ownership: registry,
      sweepClock: new TestClock(),
    });
    try {
      const held = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-own-') });
      const entries = await registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ engineId: 'mock', ownerPid: process.pid });
      expect(isPidAlive(entries[0]!.enginePid)).toBe(true);

      held.release();
      await manager.quit();
      // A graceful stop leaves nothing behind for a later sweep to consider.
      let remaining = (await registry.list()).length;
      const deadline = Date.now() + 5_000;
      while (remaining > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        remaining = (await registry.list()).length;
      }
      expect(remaining).toBe(0);
    } finally {
      await manager.quit().catch(() => undefined);
    }
  });
});

describe('supervisor', () => {
  const hostFixture = new URL('./fixtures/orphan-host.ts', import.meta.url).pathname;

  /** One process the fixture found below the one runskein holds. */
  interface Descendant {
    pid: number;
    ppid: number;
    command: string;
  }

  /**
   * Start a sacrificial host and wait for it to report the tree it spawned.
   *
   * The engine runs in its own process group, so killing the host's group does
   * not reap it; its pid is registered for cleanup as soon as the fixture
   * reports it, including when the fixture reports a failed observation.
   * @param supervise - whether the adapter declares the watchdog.
   * @param tag - distinctive argv fragment for the fake engine.
   * @returns the host process plus the tree it created.
   * @throws when the fixture never reported, or reported that `ps` failed.
   */
  async function startHost(
    supervise: boolean,
    tag: string,
  ): Promise<{ host: ChildProcess; topPid: number; descendants: Descendant[] }> {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'runskein-sup-')), 'pids.json');
    const host = spawn(
      process.execPath,
      ['--experimental-strip-types', hostFixture, pidFile, supervise ? '1' : '0', tag],
      { stdio: 'ignore', detached: true },
    );
    spawned.push(host);
    let payload: { topPid: number; descendants: Descendant[]; error?: string } | undefined;
    await until(() => {
      try {
        payload = JSON.parse(readFileSync(pidFile, 'utf8')) as typeof payload;
        return payload?.topPid !== undefined;
      } catch {
        return false;
      }
    }, 20_000);
    if (!payload) throw new Error('host never reported its pids');
    orphanedGroups.push(payload.topPid);
    if (payload.error !== undefined) throw new Error(`fixture could not observe: ${payload.error}`);
    return { host, topPid: payload.topPid, descendants: payload.descendants };
  }

  it('AC-1.1: SIGKILL of the host takes the whole supervised tree with it', async () => {
    const { host, topPid, descendants } = await startHost(true, 'runskein-sup-victim');
    // The watchdog is what runskein holds; below it sit the engine AND the
    // engine's own child, mirroring `npx -> node`. Both must die.
    expect(descendants.length).toBeGreaterThanOrEqual(2);
    expect(isPidAlive(topPid)).toBe(true);

    process.kill(host.pid!, 'SIGKILL');

    // Every process in the tree, scoped to pids this test caused to exist.
    for (const pid of [topPid, ...descendants.map((d) => d.pid)]) {
      expect(await until(() => !isPidAlive(pid), 5_000)).toBe(true);
    }
  }, 40_000);

  it('AC-1.2: an unsupervised adapter puts the engine directly under the host', async () => {
    const { host, topPid } = await startHost(false, 'runskein-unsup-shape');
    const command = await new Promise<string>((resolve) => {
      execFile('ps', ['-p', String(topPid), '-o', 'command='], (_e, stdout) => resolve(stdout.trim()));
    });
    // No watchdog interposed: what runskein holds IS the engine.
    expect(command).toContain('runskein-unsup-shape');
    expect(command).not.toContain('supervisor.mjs');

    process.kill(host.pid!, 'SIGKILL');
    // Documents the leak this capability exists for: without the watchdog the
    // engine survives its dead host, which is why claude-code declares it.
    await new Promise((r) => setTimeout(r, 500));
    expect(isPidAlive(topPid)).toBe(true);
    try {
      process.kill(-topPid, 'SIGKILL');
    } catch {
      /* nothing left to clean */
    }
  }, 40_000);

  it('AC-1.2: a supervised adapter interposes exactly one watchdog', async () => {
    const tag = 'runskein-sup-shape';
    const { host, topPid, descendants } = await startHost(true, tag);
    const command = await new Promise<string>((resolve) => {
      execFile('ps', ['-p', String(topPid), '-o', 'command='], (_e, stdout) => resolve(stdout.trim()));
    });
    expect(command).toContain('supervisor.mjs');
    // The shape, not the size: a count cannot tell one watchdog over an engine
    // and its child from a chain of two watchdogs over one process, and it
    // reads a tree caught mid-assembly as a finished one.
    const engine = descendants.filter((d) => d.ppid === topPid);
    expect(engine).toHaveLength(1);
    expect(engine[0]!.command).toContain(tag);
    const grandchildren = descendants.filter((d) => d.ppid === engine[0]!.pid);
    expect(grandchildren).toHaveLength(1);
    expect(grandchildren[0]!.command).toContain(`${tag}-child`);
    // Nothing below the watchdog is another watchdog.
    expect(descendants.filter((d) => d.command.includes('supervisor.mjs'))).toHaveLength(0);
    // And the tree is exactly those two, so nothing else was interposed.
    expect(descendants).toHaveLength(2);
    process.kill(host.pid!, 'SIGKILL');
  }, 40_000);
});

describe('the supervisor adds no ACP hop', () => {
  /**
   * Reduce a transcript to what must be identical across two runs.
   *
   * `seq` is compared because ordering and count are exactly what a relay in
   * the middle would disturb. `ts`, the runskein session id, and the engine's own
   * session id legitimately differ per run and are dropped.
   * @param events - one session's transcript.
   * @returns a comparable projection.
   */
  function normalize(events: TranscriptEvent[]): unknown[] {
    return events.map((event) => {
      const update = JSON.parse(JSON.stringify(event.update)) as {
        _meta?: Record<string, { nativeSessionId?: string }>;
      };
      const meta = update._meta?.[RUNSKEIN_SESSION_META_KEY];
      if (meta && 'nativeSessionId' in meta) delete meta.nativeSessionId;
      return { seq: event.seq, update };
    });
  }

  /**
   * Drive one deterministic conversation and return its normalized transcript.
   * @param supervise - whether the adapter declares the watchdog.
   * @returns the comparable transcript projection.
   */
  async function runConversation(supervise: boolean, cwd: string): Promise<unknown[]> {
    const adapter = supervise ? { ...mockAdapter(), supervise: true } : mockAdapter();
    const hub = makeHub({}, { orphanSweep: { ownership: fileOwnershipRegistry(registryPath()) } }, [
      adapter,
    ]);
    const session = await hub.session({ engine: 'mock', cwd });
    await session.prompt('first');
    await session.prompt('second');
    const events: TranscriptEvent[] = [];
    for await (const event of hub.transcripts.get(session.id)) events.push(event);
    await session.close();
    return normalize(events);
  }

  it('AC-1.4: identical prompts produce identical transcripts either way', async () => {
    // Same cwd both times: it is genuine input, recorded in the transcript, so
    // varying it would make the runs differ for a reason unrelated to the hop.
    const cwd = tmp('runskein-hop-');
    const plain = await runConversation(false, cwd);
    const supervised = await runConversation(true, cwd);
    expect(supervised).toEqual(plain);
    // Guard against the comparison passing because both sides are empty.
    expect(plain.length).toBeGreaterThan(4);
  }, 60_000);
});

describe('a reap that fails is not reported as success', () => {
  it('keeps the entry so a later sweep tries again', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const survivor = plantProcess('runskein-orphan-survivor');
    await awaitInspectable(survivor, 'runskein-orphan-survivor');
    const plantedAt = Date.now();
    await registry.add({
      enginePid: survivor.pid!,
      engineId: 'mock',
      ownerPid: 999_999,
      argv0: 'runskein-orphan-survivor',
      startedAt: plantedAt,
    });

    // A stop chain that reports honestly that the process is still there.
    const result = await sweepOrphans(registry, async () => false);

    // `prunedStaleEntries: 1` has two causes and the count names neither: the
    // pid was not alive, or `identityMatches` said the live pid is not this
    // entry. This failed once on a CI runner and the number was all it said.
    expect(
      result,
      result.prunedStaleEntries === 0
        ? ''
        : `the sweep pruned the entry. isPidAlive(${String(survivor.pid)}) = ${String(
            isPidAlive(survivor.pid!),
          )}\n${await whyIdentityFailed(survivor.pid!, {
            enginePid: survivor.pid!,
            engineId: 'mock',
            ownerPid: 999_999,
            argv0: 'runskein-orphan-survivor',
            startedAt: plantedAt,
          })}`,
    ).toMatchObject({ scanned: 1, reaped: 0, prunedStaleEntries: 0 });
    // Still on file: forgetting it would mean nobody ever cleans it up.
    expect((await registry.list()).map((e) => e.enginePid)).toEqual([survivor.pid]);
  });
});

describe('pid recycling', () => {
  it('refuses to kill a live process whose command matches but whose start time does not', async () => {
    // The dangerous case, and the reason the command line alone is not an
    // identity: every host running the same engine launches a byte-identical
    // one, so a recycled pid can belong to ANOTHER host's live engine and match
    // the recorded signature perfectly. Only the start time separates them.
    const registry = fileOwnershipRegistry(registryPath());
    const impostor = plantProcess('runskein-orphan-recycled');
    await awaitInspectable(impostor, 'runskein-orphan-recycled');
    await registry.add({
      enginePid: impostor.pid!,
      engineId: 'mock',
      ownerPid: 999_999, // owner long dead
      argv0: 'runskein-orphan-recycled', // command line matches exactly
      startedAt: Date.now() - 3_600_000, // but the record is an hour old
    });

    const reaped: number[] = [];
    const result = await sweepOrphans(registry, async (pid) => {
      reaped.push(pid);
      return true;
    });

    expect(reaped).toEqual([]); // never killed
    expect(result).toMatchObject({ reaped: 0, prunedStaleEntries: 1 });
    expect(isPidAlive(impostor.pid!)).toBe(true); // and still running
  });

  it('an entry with no usable timestamp is never a kill candidate', async () => {
    const registry = fileOwnershipRegistry(registryPath());
    const victim = plantProcess('runskein-orphan-notime');
    await awaitInspectable(victim, 'runskein-orphan-notime');
    await registry.add({
      enginePid: victim.pid!,
      engineId: 'mock',
      ownerPid: 999_999,
      argv0: 'runskein-orphan-notime',
      startedAt: 0,
    });

    const reaped: number[] = [];
    await sweepOrphans(registry, async (pid) => {
      reaped.push(pid);
      return true;
    });

    expect(reaped).toEqual([]);
    expect(isPidAlive(victim.pid!)).toBe(true);
  });
});

/**
 * What `identityMatches` saw, for a verdict that came out wrong.
 *
 * The verdict is one word and both of its `mismatch` paths produce it, so a
 * failure says nothing about which check fired. This reads the process again
 * and reports both inputs — and says plainly that it is a second read, because
 * a re-read that now looks right is itself the answer: the state was transient.
 * @param pid - the process the verdict was about.
 * @param entry - the record it was checked against.
 * @returns a message naming the command line, the drift, and which check fails.
 */
async function whyIdentityFailed(pid: number, entry: OwnershipEntry): Promise<string> {
  const info = await readProcessInfo(pid);
  if (info === undefined)
    return `re-read of pid ${pid}: ps returned nothing (the process is gone or unreadable)`;
  // These two restate what `identityMatches` computes. A diagnostic that has
  // drifted from the thing it explains is worse than none, so both branches are
  // driven against the real function in the case below rather than trusted.
  const nameMatches = info.command.includes(entry.argv0);
  const drift = Math.abs(Date.now() - info.elapsedSeconds * 1_000 - entry.startedAt);
  return [
    `re-read of pid ${pid} (a second ps, not the one the verdict used):`,
    `  command:  ${JSON.stringify(info.command)}`,
    `  looking for argv0: ${JSON.stringify(entry.argv0)} → ${nameMatches ? 'present' : 'ABSENT (this is the mismatch)'}`,
    `  elapsed:  ${String(info.elapsedSeconds)}s`,
    `  drift:    ${String(drift)}ms against a ${String(START_TIME_TOLERANCE_MS)}ms tolerance` +
      `${drift <= START_TIME_TOLERANCE_MS ? '' : ' → OUT OF TOLERANCE (this is the mismatch)'}`,
  ].join('\n');
}

describe('identityMatches', () => {
  it('matches a live process it really describes', async () => {
    const child = plantProcess('runskein-identity-live');
    await awaitInspectable(child, 'runskein-identity-live');
    const entry: OwnershipEntry = {
      enginePid: child.pid!,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'runskein-identity-live',
      startedAt: Date.now(),
    };
    const verdict = await identityMatches(child.pid!, entry);
    // This case has failed on CI with `mismatch` for a process it spawned
    // milliseconds earlier, on a commit whose only diff was Markdown. The
    // verdict alone cannot say which of the two checks produced it, so the
    // failure carries what the process actually looks like.
    expect(verdict, verdict === 'match' ? '' : await whyIdentityFailed(child.pid!, entry)).toBe('match');
  });

  it('the failure report names which of the two checks produced the mismatch', async () => {
    // The helper above restates the drift arithmetic `identityMatches` owns, so
    // it can drift from it and start describing the wrong branch. Both branches
    // are driven here against the real function: whatever the verdict is for, the
    // report has to agree.
    const child = plantProcess('runskein-identity-report');
    await awaitInspectable(child, 'runskein-identity-report');
    const base: OwnershipEntry = {
      enginePid: child.pid!,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'runskein-identity-report',
      startedAt: Date.now(),
    };

    const wrongName = { ...base, argv0: 'a-tag-this-process-does-not-carry' };
    expect(await identityMatches(child.pid!, wrongName)).toBe('mismatch');
    const nameReport = await whyIdentityFailed(child.pid!, wrongName);
    expect(nameReport).toContain('ABSENT (this is the mismatch)');
    expect(nameReport).not.toContain('OUT OF TOLERANCE');

    // A recorded start time far from the observed one is the other path, and
    // the only one a command-line check cannot see.
    const wrongClock = { ...base, startedAt: Date.now() - START_TIME_TOLERANCE_MS * 10 };
    expect(await identityMatches(child.pid!, wrongClock)).toBe('mismatch');
    const clockReport = await whyIdentityFailed(child.pid!, wrongClock);
    expect(clockReport).toContain('OUT OF TOLERANCE (this is the mismatch)');
    expect(clockReport).not.toContain('ABSENT');
  });

  it('reports unknown — not mismatch — when the process cannot be inspected', async () => {
    // Conflating the two is what would let an uninspectable process's record be
    // discarded while the process kept running; on Windows that would be every
    // record, so the registry would silently forget every live orphan.
    const verdict = await identityMatches(999_999, {
      enginePid: 999_999,
      engineId: 'mock',
      ownerPid: 1,
      argv0: 'anything',
      startedAt: Date.now(),
    });
    expect(verdict).toBe('unknown');
  });
});

describe('the production timer path', () => {
  it('sweeps periodically with NO injected clock, and stops on quit', async () => {
    // Every other test here injects a clock, which makes the real-timer path —
    // the one that actually ships — the untested configuration. This drives it
    // with a tiny interval instead of mocking it away.
    const runs: OrphanSweepResult[] = [];
    const manager = new ProcessManager({
      ownership: fileOwnershipRegistry(registryPath()),
      sweepIntervalMs: 25,
      onSweep: (result) => runs.push(result),
    });
    try {
      const held = await manager.acquire(mockAdapter(), { cwd: tmp('runskein-own-') });
      // At least the pre-acquire sweep. With a 25 ms interval and a real timer,
      // spawning the engine takes long enough that a periodic run may already
      // have fired too — which is the path working, not a fault.
      expect(runs.length).toBeGreaterThanOrEqual(1);

      // Real timers, real rescheduling: each run must arm the next.
      expect(await until(() => runs.length >= 4, 5_000)).toBe(true);

      held.release();
      await manager.quit();
      const afterQuit = runs.length;
      await new Promise((r) => setTimeout(r, 200)); // several intervals
      expect(runs).toHaveLength(afterQuit);
    } finally {
      await manager.quit().catch(() => undefined);
    }
  }, 20_000);
});

describe('the registry under concurrent hosts', () => {
  it('an append that races a compaction is lost, never corrupted', async () => {
    // Two hosts share one file with no lock. The documented trade: a compaction
    // that reads before another host's append and renames after it drops that
    // record. Losing a record risks a leaked engine; a torn or half-applied
    // file could get a LIVE process killed, so this is the safe direction.
    const path = registryPath();
    const a = fileOwnershipRegistry(path);
    const b = fileOwnershipRegistry(path);
    const entry = (pid: number): OwnershipEntry => ({
      enginePid: pid,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'node',
      startedAt: Date.now(),
    });
    await a.add(entry(1));
    await a.add(entry(2));

    await Promise.all([a.compact([1]), b.add(entry(3))]);

    const remaining = await a.list();
    // Whatever survived is a complete, parseable set of records — never a
    // partial line or a resurrected duplicate.
    expect(remaining.every((e) => Number.isInteger(e.enginePid))).toBe(true);
    expect(new Set(remaining.map((e) => e.enginePid)).size).toBe(remaining.length);
    expect(remaining.map((e) => e.enginePid)).toContain(2);
  });

  it('a compaction leaves no temporary file behind on success', async () => {
    const path = registryPath();
    const registry = fileOwnershipRegistry(path);
    await registry.add({
      enginePid: 7,
      engineId: 'mock',
      ownerPid: process.pid,
      argv0: 'node',
      startedAt: Date.now(),
    });
    await registry.compact([7]);
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('legacy registry migration (ADR 039, delete before 1.0)', () => {
  const legacyOf = (target: string): string =>
    join(dirname(dirname(target)), 'realm-node', basename(target));

  it('carries pre-rename entries into the current registry and removes the old file', () => {
    const base = mkdtempSync(join(tmpdir(), 'runskein-mig-'));
    const target = join(base, 'runskein', 'engines.jsonl');
    const legacy = legacyOf(target);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({ enginePid: 4242, engineId: 'codex', ownerPid: 7, startedAt: 1 })}\n`,
    );

    expect(migrateLegacyRegistry(target)).toBe(1);
    expect(readFileSync(target, 'utf8')).toContain('4242');
    expect(existsSync(legacy)).toBe(false);
  });

  it('appends rather than moving, so an existing registry survives the upgrade', () => {
    // The case a "move only if the target is absent" guard would have skipped:
    // by the time a host upgrades, both files can already exist.
    const base = mkdtempSync(join(tmpdir(), 'runskein-mig-'));
    const target = join(base, 'runskein', 'engines.jsonl');
    const legacy = legacyOf(target);
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      target,
      `${JSON.stringify({ enginePid: 11, engineId: 'kimi', ownerPid: 7, startedAt: 1 })}\n`,
    );
    writeFileSync(
      legacy,
      `${JSON.stringify({ enginePid: 22, engineId: 'pi', ownerPid: 7, startedAt: 1 })}\n`,
    );

    expect(migrateLegacyRegistry(target)).toBe(1);
    const merged = readFileSync(target, 'utf8');
    expect(merged).toContain('11');
    expect(merged).toContain('22');
  });

  it('is a no-op the second time, and when there is nothing to carry', () => {
    const base = mkdtempSync(join(tmpdir(), 'runskein-mig-'));
    const target = join(base, 'runskein', 'engines.jsonl');
    expect(migrateLegacyRegistry(target)).toBe(0);

    const legacy = legacyOf(target);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      `${JSON.stringify({ enginePid: 33, engineId: 'pi', ownerPid: 7, startedAt: 1 })}\n`,
    );
    expect(migrateLegacyRegistry(target)).toBe(1);
    expect(migrateLegacyRegistry(target)).toBe(0);
    expect(readFileSync(target, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
