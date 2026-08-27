/**
 * ST-ORPH-05 — a real engine tree does not outlive an uncleanly killed host
 * (AC-1.1, live).
 *
 * This is the case the whole supervision capability exists for. Measured
 * evidence: `@zed-industries/claude-code-acp` does not exit on stdin EOF, so
 * every host that died without a clean shutdown leaked one — 8 were reaped by
 * hand in a single working session, and 12 were once found accumulated on a dev
 * machine. This converts that into a recurring red/green signal.
 *
 * It is the only case that exercises three things no fixture can:
 *   - the real wrapper depth, `npx -> node -> engine`, which is where the
 *     watchdog's first defect lived (it killed npx and left the engine running);
 *   - AC-1.1's 5 s bound against a real engine rather than a local fixture;
 *   - a genuinely detached tree owned by a host that is gone.
 *
 * It runs outside the live suite because it kills its own host: no teardown of
 * the dead host can run, so this harness records what to clean up beforehand
 * and does the cleaning itself afterwards.
 *
 * Usage: pnpm --filter @runskein/conformance st:orph05 [engineId]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { builtinAdapters } from 'runskein';

const engineId = process.argv[2] ?? 'claude-code';
const adapter = builtinAdapters.find((a) => a.id === engineId);
if (adapter === undefined) {
  console.error(`unknown engine: ${engineId}`);
  process.exit(2);
}

const HOST = resolve(import.meta.dirname, 'st-orph-05-host.ts');
const TSX = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
const AC_BOUND_MS = 5_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every live pid whose command line names this engine.
 *
 * `-A` because the tree is detached and shares no terminal with this process;
 * `-ww` because ps truncates to terminal width and these command lines are long
 * enough that a truncated one would silently fail to match.
 * @returns matching pids.
 */
function enginePids(): number[] {
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (m[2]!.includes(engineId) && !m[2]!.includes('st-orph-05')) pids.push(Number(m[1]));
  }
  return pids;
}

const dir = mkdtempSync(join(tmpdir(), 'runskein-orph05-'));
const config = {
  engineId,
  cwd: dir,
  registryPath: join(dir, 'registry.jsonl'),
  readyFile: join(dir, 'ready.json'),
};
writeFileSync(join(dir, 'config.json'), JSON.stringify(config));

const before = new Set(enginePids());
console.log(`━━━ ST-ORPH-05 [engine=${engineId}] ━━━`);
console.log(`STEP 1/5 ${before.size} pre-existing ${engineId} process(es) will be ignored`);

const wrapper = spawn(TSX, [HOST, join(dir, 'config.json')], { stdio: 'inherit' });

const deadline = Date.now() + 180_000;
while (Date.now() < deadline && !existsSync(config.readyFile)) {
  await new Promise((r) => setTimeout(r, 200));
}
if (!existsSync(config.readyFile)) {
  console.error('FAIL host never reported ready (engine unavailable or unauthenticated?)');
  try {
    wrapper.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  process.exit(1);
}

const ready = JSON.parse(readFileSync(config.readyFile, 'utf8')) as {
  hostPid: number;
  nativeSessionId?: string;
};
const entries = readFileSync(config.registryPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { enginePid: number });
// The tree this run is responsible for: everything named after the engine that
// was not already running, plus whatever runskein recorded owning.
const spawnedTree = [
  ...new Set([...enginePids().filter((pid) => !before.has(pid)), ...entries.map((e) => e.enginePid)]),
];
console.log(`STEP 2/5 host ${ready.hostPid} live; tree = ${spawnedTree.join(', ')}`);
if (spawnedTree.length === 0) {
  console.error('FAIL no engine process was attributable to this run');
  process.exit(1);
}

// The whole point: the host dies with no chance to clean up after itself.
process.kill(ready.hostPid, 'SIGKILL');
const killedAt = Date.now();
console.log('STEP 3/5 host SIGKILLed');

let survivors: number[] = [];
for (;;) {
  survivors = spawnedTree.filter(alive);
  if (survivors.length === 0 || Date.now() - killedAt > AC_BOUND_MS + 5_000) break;
  await new Promise((r) => setTimeout(r, 100));
}
const elapsed = Date.now() - killedAt;
console.log(`STEP 4/5 ${survivors.length} survivor(s) after ${elapsed}ms`);

// Cleanup is this harness's job precisely because the host cannot do it.
const leftovers = [...survivors, ...enginePids().filter((pid) => !before.has(pid))];
for (const pid of new Set(leftovers)) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
try {
  wrapper.kill('SIGKILL');
} catch {
  /* already gone */
}
console.log(`STEP 5/5 janitor reaped ${new Set(leftovers).size} leftover process(es)`);

if (survivors.length > 0) {
  console.error(
    `FAIL ${survivors.length} process(es) outlived the host past ${AC_BOUND_MS}ms: ${survivors.join(', ')}`,
  );
  process.exit(1);
}
if (elapsed > AC_BOUND_MS) {
  // A real tree taking longer than the AC allows is a finding about the bound,
  // not a licence to widen it here.
  console.error(`FAIL tree died only after ${elapsed}ms, beyond AC-1.1's ${AC_BOUND_MS}ms bound`);
  process.exit(1);
}
console.log(`PASS whole tree gone ${elapsed}ms after the host died (bound ${AC_BOUND_MS}ms)`);
