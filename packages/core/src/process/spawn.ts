/**
 * Engine process spawning with env hygiene (measured finding):
 * host-agent session markers must be scrubbed or child agents refuse to start
 * (e.g. a parent Claude Code session's CLAUDE* vars make claude-code-acp
 * refuse with "active session"). Adapter env is applied AFTER the scrub.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EngineAdapter } from '../types.js';

/** The parent-death watchdog launched for adapters that declare `supervise`. */
const SUPERVISOR_PATH = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));

/** Core scrub list; adapters extend via envScrubExtra. */
export const ENV_SCRUB_PATTERNS: readonly RegExp[] = [
  /^(CLAUDE|CLAUDECODE|CODEX_SANDBOX|OPENCODE_(SESSION|CALLER))/,
];

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
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !patterns.some((pattern) => {
          pattern.lastIndex = 0;
          return pattern.test(entry[0]);
        }),
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
 * Launch the adapter's engine command in its own process group with scrubbed
 * env; spawn failures surface later via the child's 'error' event.
 * @param adapter - The adapter whose launch config drives the spawn.
 * @param opts - cwd for the child process.
 * @returns The spawned child plus a stderrTail() accessor for diagnostics.
 */
export function spawnEngine(adapter: EngineAdapter, opts: { cwd: string }): SpawnedEngine {
  const env = {
    ...scrubEnv(process.env, adapter.envScrubExtra ?? []),
    ...adapter.launch.env,
  };
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
  const command = supervised ? process.execPath : engineCommand;
  const args = supervised ? [SUPERVISOR_PATH, engineCommand, ...engineArgs] : engineArgs;
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
