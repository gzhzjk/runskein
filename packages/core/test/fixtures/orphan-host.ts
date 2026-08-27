/**
 * A sacrificial host for the parent-death test.
 *
 * Runs the real spawnEngine so the supervisor is wired exactly as production
 * wires it, reports the pids it created, and then does nothing — waiting to be
 * killed. Run with `node --experimental-strip-types`.
 *
 * Usage: orphan-host.ts <pidFile> <supervise:0|1> <engineTag>
 */
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { spawnEngine } from '../../src/process/spawn.ts';

const [pidFile, superviseFlag, engineTag] = process.argv.slice(2);

// A stand-in for a badly-behaved engine. Two properties matter and both are
// deliberate: it ignores stdin EOF entirely, which is the whole reason the
// watchdog exists; and it spawns a child of its own, because the real target is
// launched as `npx -y <pkg>`, where npx is the direct child and the process
// that actually speaks ACP is the grandchild. A childless stand-in would let a
// watchdog that only signals its direct child pass while leaking the engine.
// The grandchild also IGNORES SIGTERM, because the real leak has that shape: a
// wrapper exits on the polite signal while the process it spawned does not, so
// a watchdog that stops as soon as its own child is gone leaves the engine
// running. Without this the fixture cannot tell that failure from success.
const engineScript =
  `/*${engineTag}*/ ` +
  `require('child_process').spawn(process.execPath, ['-e', '/*${engineTag}-child*/ process.on(\\'SIGTERM\\',()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'}); ` +
  `process.stdin.resume(); setInterval(() => {}, 1000);`;

const spawned = spawnEngine(
  {
    specVersion: 1,
    id: 'orphan-mock',
    launch: { command: process.execPath, args: ['-e', engineScript] },
    ...(superviseFlag === '1' ? { supervise: true } : {}),
  },
  { cwd: process.cwd() },
);

const topPid = spawned.child.pid;

/** One process below `topPid`, with what the caller needs to judge the shape. */
interface Descendant {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Every process below `topPid`, whatever its depth.
 *
 * The parent and the command line come along: a count cannot tell "one watchdog
 * over an engine and its child" from "two watchdogs over one process", and the
 * caller asserts the shape, not the size.
 * @returns the descendants; empty while the tree is still coming up.
 * @throws whatever `ps` failed with.
 */
async function descendantsOf(): Promise<Descendant[]> {
  // -A because these processes are detached and therefore attached to no
  // terminal; a bare `ps` lists only the caller's terminal and would find none.
  // A failed `ps` is reported as such: reading it as an empty tree would turn a
  // broken observation into "the supervisor spawned nothing", which is the same
  // symptom as the defect these cases exist to catch.
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,command='], (error, out) => {
      if (error) reject(error);
      else resolve(out);
    });
  });
  const rows = stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]!), ppid: Number(m[2]!), command: m[3]! }));
  // The whole tree, not just direct children: a watchdog that signals only
  // its immediate child would leave grandchildren behind, and reporting only
  // one level would hide exactly that.
  const descendants: Descendant[] = [];
  let frontier = [topPid!];
  while (frontier.length > 0) {
    const next = rows.filter((r) => frontier.includes(r.ppid));
    descendants.push(...next);
    frontier = next.map((r) => r.pid);
  }
  return descendants;
}

/**
 * Report the spawned pids: the process runskein holds, and any descendant of it.
 *
 * The tree comes up in stages — the watchdog starts the engine, which starts a
 * child of its own — so a single snapshot at a fixed delay reports whatever
 * happened to exist by then, and on a loaded machine that is nothing.
 *
 * Waiting for a count is not enough either: the caller asserts the exact shape,
 * and a tree that grows through the expected count on its way to a larger one
 * would be frozen mid-flight and read as correct. So this waits for the tree to
 * stop moving — the same pid set twice in a row, at least the minimum the shape
 * requires — and only then reports. If it never settles, it reports the last
 * reading rather than hanging, so the assertion names the real shape.
 * A failed `ps` is reported too, rather than thrown out of here. The engine is
 * already running in its own process group by then, and dying with an
 * unhandled rejection would strand it: the caller learns the engine's pid only
 * from this file, so a file it never gets is an engine nobody can reap.
 * @returns nothing; writes the pid file and keeps the host alive.
 */
async function report(): Promise<void> {
  // With the watchdog: the engine and the engine's own child. Without it:
  // runskein holds the engine itself, so only that child is below it.
  const minimum = superviseFlag === '1' ? 2 : 1;
  const deadline = Date.now() + 15_000;
  let descendants: Descendant[] = [];
  let error: string | undefined;
  try {
    let previous = await descendantsOf();
    descendants = previous;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      descendants = await descendantsOf();
      const settled =
        descendants.length >= minimum &&
        descendants.length === previous.length &&
        descendants.every((row, i) => row.pid === previous[i]?.pid);
      if (settled) break;
      previous = descendants;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  writeFileSync(
    pidFile!,
    JSON.stringify({ topPid, descendants, ...(error !== undefined ? { error } : {}) }),
    'utf8',
  );
}

void report();
setInterval(() => {}, 1000);
