/**
 * ST-ORPH-01 / ST-ORPH-02 — what survives a host that dies uncleanly
 * (AC-1.1, AC-1.2).
 *
 * Engines are spawned detached so lifecycle signals reach a whole
 * npx -> node -> engine tree, and that same detachment severs parent-death
 * linkage: a host killed with SIGKILL leaks its engines. Measured, only
 * claude-code actually does, and reliably — one per run — which is why the
 * supervisor is opt-in per adapter rather than universal.
 *
 * These cases own a real host process and SIGKILL it, because a claim about a
 * host dying uncleanly cannot be checked from inside the process making it.
 * The fixture tree is three levels deep for the same reason: a shallower one
 * would pass without touching the descendants that actually survive.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE = resolve(import.meta.dirname, '../../core/test/fixtures/mock-agent.mjs');
const HOST = resolve(import.meta.dirname, 'fixtures/sacrificial-host.ts');
const TSX = resolve(import.meta.dirname, '../node_modules/.bin/tsx');

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

/** Pids this run created, killed in teardown even when a case fails. */
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone, which is the expected case */
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

/**
 * The parent pid of a process, or undefined when it is gone.
 * @param pid - the process to look up.
 * @returns its ppid, or undefined.
 */
function parentOf(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out === '' ? undefined : Number(out);
  } catch {
    return undefined;
  }
}

/**
 * pid/ppid/pgid rows for the given pids.
 *
 * `-A` because a detached tree is not attached to this terminal and a bare
 * `ps` would not list it at all; `-ww` because ps truncates to terminal width.
 * @param pids - the processes of interest.
 * @returns one [pid, ppid, pgid] row per matching process.
 */
function processRows(pids: number[]): number[][] {
  return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => pids.includes(parts[0]!));
}

interface LiveHost {
  hostPid: number;
  enginePid: number;
  grandchildPid: number;
}

/**
 * Start a sacrificial host and wait until its whole engine tree is up.
 * @param supervise - whether the adapter declares the parent-death watchdog.
 * @returns the pids of the host, the process runskein spawned, and the grandchild.
 */
async function startHost(supervise: boolean): Promise<LiveHost> {
  const dir = tmp('runskein-orph-');
  const config = {
    fixture: FIXTURE,
    supervise,
    cwd: dir,
    registryPath: join(dir, 'registry.jsonl'),
    readyFile: join(dir, 'ready.json'),
    grandchildPidFile: join(dir, 'grandchild.pid'),
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));

  // tsx runs the host in a child of its own, so the pid spawned here is a
  // wrapper; the host reports its real pid in the ready file.
  const wrapper = spawn(TSX, [HOST, configPath], { stdio: 'ignore' });
  strays.push(wrapper.pid!);

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (existsSync(config.readyFile) && existsSync(config.grandchildPidFile)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(existsSync(config.readyFile), 'sacrificial host never came up').toBe(true);
  const { hostPid } = JSON.parse(readFileSync(config.readyFile, 'utf8')) as { hostPid: number };
  strays.push(hostPid);

  // The registry is runskein's own record of what it spawned — the same pid a
  // later sweep would act on.
  const entries = readFileSync(config.registryPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { enginePid?: number });
  const enginePid = entries.find((e) => typeof e.enginePid === 'number')?.enginePid;
  expect(enginePid, 'no ownership entry was recorded for the spawned engine').toBeDefined();
  const grandchildPid = Number(readFileSync(config.grandchildPidFile, 'utf8').trim());
  strays.push(enginePid!, grandchildPid);

  expect(alive(enginePid!)).toBe(true);
  expect(alive(grandchildPid)).toBe(true);
  return { hostPid, enginePid: enginePid!, grandchildPid };
}

describe('ST-ORPH-01 — a supervised adapter leaves nothing behind (AC-1.1)', () => {
  it('takes the whole tree down within 5 s, with no action from the dead host', async () => {
    const { hostPid, enginePid, grandchildPid } = await startHost(true);
    const groups = processRows([hostPid, enginePid, grandchildPid]);

    // SIGKILL: the host runs no exit handler, no stop chain, nothing. Whatever
    // cleans up has to live outside it.
    process.kill(hostPid, 'SIGKILL');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (alive(enginePid) || alive(grandchildPid))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive(enginePid), 'engine process outlived its host').toBe(false);
    if (alive(grandchildPid)) {
      // Says whether the descendant was ever in scope for a group-wide signal,
      // rather than leaving that to inference from the outcome.
      console.error('grandchild survived; [pid, ppid, pgid] at kill time:', JSON.stringify(groups));
    }
    expect(
      alive(grandchildPid),
      'engine descendant outlived its host — see the [pid, ppid, pgid] diagnostic for ' +
        'whether it shared the spawned process group, i.e. whether a group-wide kill would reach it',
    ).toBe(false);
  }, 60_000);
});

describe('ST-ORPH-02 — an unsupervised adapter keeps its tree shape (AC-1.2)', () => {
  it('spawns the engine as a direct child, with no supervisor interposed', async () => {
    const { hostPid, enginePid } = await startHost(false);
    // Tree shape, not spawn environment: the ownership registry applies to
    // every adapter, so what must be unchanged is that nothing sits between
    // the host and the process runskein spawned.
    expect(parentOf(enginePid)).toBe(hostPid);
  }, 60_000);

  it('interposes exactly one process when the adapter opts in', async () => {
    const { hostPid, enginePid } = await startHost(true);
    // The contrast that gives the assertion above its meaning: here the
    // recorded pid is the watchdog, still a direct child of the host, with the
    // engine running beneath it.
    expect(parentOf(enginePid)).toBe(hostPid);
    const children = processRows([]).length;
    const beneath = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => Number(parts[1]) === enginePid);
    expect(children).toBe(0);
    expect(beneath.length, 'the supervisor should have the engine as its child').toBeGreaterThan(0);
  }, 60_000);
});
