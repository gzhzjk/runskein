/**
 * Engine process spawning with env hygiene (measured finding):
 * host-agent session markers must be scrubbed or child agents refuse to start
 * — a parent Claude Code session's `CLAUDE*` variables make the Claude Code
 * ACP wrapper refuse with "active session". Which markers those are is each
 * adapter's own declaration (`envScrubExtra`), not core's; see
 * `ENV_SCRUB_PATTERNS` below. Adapter `env` is applied AFTER the scrub.
 *
 * **This module imports no other module of this package at run time, and must
 * not.** `test/fixtures/orphan-host.ts` loads it on its own under
 * `node --experimental-strip-types`, which resolves a `.js` specifier literally
 * and cannot find its `.ts` file — so a single value import from a sibling
 * breaks the parent-death fixture, and with it the only test that runs the
 * supervisor the way production does. Type-only imports are erased and are
 * fine. Anything else this needs is either passed in or thrown as a plain
 * Error for a caller to type.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EngineAdapter } from '../types.js';

/** The parent-death watchdog launched for adapters that declare `supervise`. */
const SUPERVISOR_PATH = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));

/**
 * What to say when a file this package has to spawn is not where it should be.
 *
 * Always the same three things, because one of them is what a reader is
 * missing: the asset, where it was looked for, and that a bundler is the usual
 * reason. These paths are resolved from the module's own location, so a build
 * that flattens several packages into one artifact moves them without moving
 * the files — measured, a bundled `runskein` looks for pi's shim beside the
 * consumer's own artifact.
 *
 * Shared with the shim check at registration so the two read alike: a consumer
 * who has met one of them has met both.
 * @param asset - what is missing, named as a reader would recognise it.
 * @param path - where it was looked for.
 * @returns the message.
 */
export function missingRuntimeAsset(asset: string, path: string): string {
  return (
    `${asset} not found: ${path} — this path is resolved from the module's own ` +
    'location, so a bundler that flattens the package will move it. Copy the ' +
    "package's runtime assets beside the artifact, or leave it external to the bundle"
  );
}

/**
 * Scrub patterns that belong to no single engine — empty, and that is the
 * design rather than a gap.
 *
 * A session marker is a statement an agent makes to itself: `CLAUDECODE=1`
 * means "you are already inside a Claude Code session" and means nothing to
 * kimi. So each engine's markers are declared by its own adapter, in
 * `envScrubExtra`, and reach both scrub sites through the merge below. This
 * list stays because a marker no engine owns would have nowhere else to go.
 *
 * See decision 045.
 */
export const ENV_SCRUB_PATTERNS: readonly RegExp[] = [];

/**
 * Whether a variable name matches any of the patterns, ignoring case.
 *
 * Windows resolves environment variable names without case: `Path` and `PATH`
 * are one variable there, so a guard that matched only the spelling it expected
 * would hold on one host and not another. The patterns are recompiled
 * case-insensitively rather than the name upper-cased, so that a pattern an
 * adapter wrote in lower case still means what its author wrote. The recompiled
 * pattern is always a fresh object, which is also what keeps a `g`-flagged
 * pattern from carrying `lastIndex` between calls.
 * @param patterns - the patterns to try.
 * @param name - the variable name.
 * @returns true on the first match.
 */
export function matchesEnvName(patterns: readonly RegExp[], name: string): boolean {
  return patterns.some((pattern) =>
    new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`).test(
      name,
    ),
  );
}

/**
 * Filter environment variables, dropping host-agent session markers that make
 * child engines refuse to start; adapter-scoped extras extend the scrub list.
 * @param env - The environment to filter.
 * @param extra - Additional regexes whose matching keys are scrubbed.
 * @returns A new env record with matched keys removed (undefined values dropped).
 */
export function scrubEnv(env: NodeJS.ProcessEnv, extra: readonly RegExp[] = []): Record<string, string> {
  const patterns = [...ENV_SCRUB_PATTERNS, ...extra];
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !matchesEnvName(patterns, entry[0]),
    ),
  );
}

export interface SpawnedEngine {
  child: ChildProcess;
  /** Last ~2000 chars of stderr, for crash/startup diagnostics. */
  stderrTail: () => string;
  /**
   * Launch signature recorded in the ownership registry: the full command line
   * runskein asked for, not just its first word. A sweep compares it against a
   * live process's own command line before killing anything, and a bare command
   * name would be far too easy for an unrelated process to match — `npx` alone
   * would put every npx invocation on the machine at risk.
   */
  argv0: string;
}

/**
 * Layer overrides over the environment a child inherits.
 *
 * Both callers need this: an adapter's `launch.env`, which the adapter guide
 * promises wins over the scrub, and the environment an agent asked a terminal
 * to run with. Windows resolves variable names without case, so an override
 * there has to displace the host's spelling of the same variable rather than
 * sit beside it: a child handed both `MY_FLAG` and `my_flag` receives one of
 * them, and which one is neither the adapter's choice nor something a policy
 * could have read. On POSIX the two are separate variables and the host's own
 * must survive.
 * @param base - the scrubbed host environment.
 * @param overrides - the overrides to apply, already one per name.
 * @param caseless - whether the host resolves names without case; defaults to
 *   the running platform.
 * @returns the environment to spawn with.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: readonly { name: string; value: string }[],
  caseless: boolean = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const displaced = new Set(overrides.map((entry) => entry.name.toUpperCase()));
  // Without a null prototype, assigning `__proto__` runs a setter instead of
  // creating a variable, and an approved name would never reach the child.
  // Variable names belong to whoever asked for them, not to our object.
  const merged: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(base)) {
    if (caseless && displaced.has(name.toUpperCase())) continue;
    merged[name] = value;
  }
  for (const entry of overrides) merged[entry.name] = entry.value;
  return merged;
}

/**
 * Launch the adapter's engine command in its own process group with scrubbed
 * env; spawn failures surface later via the child's 'error' event.
 * @param adapter - The adapter whose launch config drives the spawn.
 * @param opts - cwd for the child process.
 * @param supervisorPath - the watchdog a supervised adapter is launched
 *   through; the real asset by default, overridden only to test that its
 *   absence is reported rather than left to node.
 * @returns The spawned child plus a stderrTail() accessor for diagnostics.
 * @throws Error when a supervised adapter's watchdog is not where it should be;
 *   the manager types it as an EngineStartError at the `spawn` stage.
 */
export function spawnEngine(
  adapter: EngineAdapter,
  opts: { cwd: string },
  // Injectable so a test can prove the check below fires. The default is the
  // real asset, which exists in this tree — without the seam the case could
  // only be argued, not run.
  supervisorPath: string = SUPERVISOR_PATH,
): SpawnedEngine {
  const env = mergeEnv(
    scrubEnv(process.env, adapter.envScrubExtra ?? []),
    Object.entries(adapter.launch.env ?? {}).map(([name, value]) => ({ name, value })),
  );
  // An engine that speaks no ACP is reached through a shim: a separate process
  // that talks ACP on this stdio and the engine's own protocol to a child it
  // spawns itself. Everything downstream — supervision, ownership, reaping —
  // then treats the shim as the engine, which is what it is from here.
  const shim = adapter.shim;
  const engineCommand = shim === undefined ? adapter.launch.command : process.execPath;
  const engineArgs =
    shim === undefined
      ? (adapter.launch.args ?? [])
      : [shim, adapter.launch.command, ...(adapter.launch.args ?? [])];
  // Supervised adapters get a watchdog between the host and the engine. It adds
  // a fourth stdio slot carrying the read end of a pipe this process keeps the
  // write end of: when this process dies by any means, the kernel closes that
  // end and the supervisor sees EOF. The engine still inherits the same three
  // pipes, so no protocol traffic passes through the extra process.
  const supervised = adapter.supervise === true;
  // Checked before spawning rather than left to node. Without this the failure
  // is node's own "Cannot find module", which reaches the caller through the
  // 2000-character stderr tail below with its beginning sliced off — measured,
  // a consumer read a stack fragment starting mid-word at `odules/cjs/loader`.
  if (supervised && !existsSync(supervisorPath)) {
    // A plain Error on purpose; the process manager types it as an
    // EngineStartError, which is where its JSDoc already promises one.
    throw new Error(
      missingRuntimeAsset("the parent-death supervisor this adapter's `supervise` needs", supervisorPath),
    );
  }
  const command = supervised ? process.execPath : engineCommand;
  const args = supervised ? [supervisorPath, engineCommand, ...engineArgs] : engineArgs;
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env,
    stdio: supervised ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    // A distinct POSIX process group lets lifecycle operations include npx
    // wrappers and every agent descendant, not only the immediate child.
    detached: process.platform !== 'win32',
  });
  let tail = '';
  child.stderr?.on('data', (d: Buffer) => {
    tail = (tail + d.toString()).slice(-2000);
  });
  // The watchdog end is deliberately never written to and never closed here:
  // holding it open for the life of this process is the whole signal.
  // The engine command and its arguments, in the order they appear in the
  // process listing. A supervised process shows the watchdog ahead of them, so
  // this remains a substring match either way. For a shim the recorded line is
  // the shim script plus the engine command it drives — the node executable is
  // omitted deliberately, because `node` alone would match far too much for a
  // sweep that kills what it matches.
  const argv0 =
    shim === undefined
      ? [adapter.launch.command, ...(adapter.launch.args ?? [])].join(' ')
      : engineArgs.join(' ');
  return { child, stderrTail: () => tail, argv0 };
}

/**
 * Stop a process tree identified only by its group-leader pid.
 *
 * The sweep works from registry records, not from ChildProcess handles — an
 * orphan's parent is gone, so nobody holds a handle to it any more.
 * @param pid - the process group leader to stop.
 * @param graceMs - grace period after SIGTERM before SIGKILL (default 3s).
 * @returns true when the process is gone afterwards.
 */
export async function stopTreeByPid(pid: number, graceMs = 3_000): Promise<boolean> {
  const aliveByPid = (): boolean => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const signalByPid = (signal: NodeJS.Signals): void => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch {
      /* already gone, or not ours to signal */
    }
  };
  signalByPid('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (aliveByPid() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (!aliveByPid()) return true;
  signalByPid('SIGKILL');
  const hardDeadline = Date.now() + 1_000;
  while (aliveByPid() && Date.now() < hardDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !aliveByPid();
}

/**
 * Signal the whole process group (or the direct child on Windows). POSIX sends
 * to the negative pid; errors are swallowed, with a Windows-only fallback
 * re-kill while the child is still running.
 * @param child - The child process (group leader) to signal.
 * @param signal - The signal to deliver.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // On POSIX every managed child is a process-group leader. Falling back to
    // its positive pid after exit could signal an unrelated process that
    // reused the pid during the grace window.
    if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  }
}

/**
 * Gracefully request termination of the process tree.
 * @param child - The child process (group leader) to SIGTERM.
 */
export function terminateTree(child: ChildProcess): void {
  signalTree(child, 'SIGTERM');
}

/**
 * Force-kill the process tree; on Windows shells out to taskkill /T /F.
 * @param child - The child process (group leader) to SIGKILL.
 */
export function forceKillTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    // stopTree() observes whether the process actually died and reports a
    // typed failure; consume taskkill's spawn error to avoid a second channel.
    killer.on('error', () => {});
    killer.unref();
    return;
  }
  signalTree(child, 'SIGKILL');
}

/**
 * Whether the managed process group (or direct Windows child) still exists.
 * @param child - The child process to probe.
 * @returns true while the process (group) is alive, false after exit or when unpidable.
 */
export function isTreeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Poll until the process tree exits or the deadline passes.
 * @param child - The child process to wait on.
 * @param timeoutMs - Maximum time to wait in milliseconds.
 * @returns true when the tree exited within the deadline.
 */
async function waitForTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isTreeAlive(child) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !isTreeAlive(child);
}

/**
 * Bounded graceful chain: close stdin → SIGTERM → grace → SIGKILL.
 * @param child - The child process (group leader) to stop.
 * @param graceMs - Grace period after SIGTERM before SIGKILL (default 3s).
 * @returns true when the tree exited during grace or after the SIGKILL stage.
 */
export async function stopTree(child: ChildProcess, graceMs = 3_000): Promise<boolean> {
  try {
    child.stdin?.end();
  } catch {
    /* stream already gone */
  }
  terminateTree(child);
  if (await waitForTreeExit(child, graceMs)) return true;
  forceKillTree(child);
  return waitForTreeExit(child, 1_000);
}

/**
 * Resolves when the child exits (or immediately if it already has).
 * @param child - The child process to await.
 * @returns The exit code and signal, either of which may be null.
 */
export function onceExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((res) => {
    child.once('exit', (code, signal) => res({ code, signal }));
  });
}
