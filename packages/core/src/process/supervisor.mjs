/**
 * Engine supervisor — a parent-death watchdog for engines that ignore stdin EOF.
 *
 * Engines are spawned detached so lifecycle signals can reach a whole process
 * tree, which also means nothing kills them when their host dies. Well-behaved
 * engines notice stdin closing and exit on their own; at least one does not, and
 * leaks a process on every uncleanly-terminated host.
 *
 * This process closes that hole without touching the conversation. The host
 * hands it the read end of a pipe on fd 3 and keeps the write end. The kernel
 * closes a dying process's descriptors however it died — SIGKILL included — so
 * EOF on fd 3 is a reliable "my host is gone" signal, which no in-band protocol
 * message could be.
 *
 * It is NOT an ACP shim: the engine inherits this process's stdio, so its
 * JSON-RPC stream reaches the host through the very same pipes it would have
 * used without a supervisor. Nothing here reads, writes, parses, or delays a
 * single protocol byte.
 *
 * Usage: supervisor.mjs <command> [args...]
 */
import { execFileSync, spawn } from 'node:child_process';

// Everything this process reports happens AFTER its host died, so the stderr
// pipe's reader is usually gone. An unhandled EPIPE here would kill the
// watchdog mid-escalation — the one moment it must survive.
process.stderr.on('error', () => {});

/**
 * Write a diagnostic without ever letting a closed pipe take this process down.
 * @param text - the message to emit.
 */
function report(text) {
  try {
    process.stderr.write(text);
  } catch {
    /* nobody is listening any more */
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  report('supervisor: no engine command given\n');
  process.exit(2);
}

// 'inherit' is what keeps this transparent: the engine writes to the host's
// pipes directly rather than through a relay in this process.
//
// Not detached, so the engine joins this process's group and one group signal
// stops the pair together. The host spawned THIS process detached, which is
// what makes the group exist in the first place.
const engine = spawn(command, args, { stdio: 'inherit', detached: false });

let stopping = false;

/**
 * Stop the engine, escalating if it ignores the polite request.
 * @param signal - the signal to try first.
 */
function signalTree(signal) {
  // Signal the whole process group, not just the direct child. The engines that
  // need a watchdog are launched through wrappers — `npx -y <pkg>` spawns npx,
  // which spawns the node process that actually speaks ACP — so killing the
  // direct child would take out the wrapper and leave the real engine running,
  // which is the exact leak this process exists to prevent.
  //
  // The host spawns this process detached, so it leads its own group and the
  // engine plus every descendant is inside it. Signalling the group also hits
  // this process; that is intentional at the SIGKILL stage, and harmless at
  // SIGTERM because the handler below is already registered.
  try {
    if (process.platform === 'win32') engine.kill(signal);
    else process.kill(-process.pid, signal);
  } catch {
    // Not a group leader (run outside the normal spawn path), or already gone.
    try {
      engine.kill(signal);
    } catch {
      /* already gone; the exit handler owns the outcome */
    }
  }
}

/**
 * Stop the engine, escalating if it ignores the polite request.
 * @param signal - the signal to try first.
 */
function stopEngine(signal) {
  if (stopping) return;
  stopping = true;
  signalTree(signal);
  // The engine this exists for is one that ignores shutdown hints, so the
  // escalation is the point rather than a formality.
  const force = setTimeout(() => {
    signalTree('SIGKILL');
    // Normally unreachable: the group signal above includes this process, so it
    // dies here. Reaching the next line means the kill did NOT land, and
    // exiting 0 then would report a success that did not happen — the same
    // mistake the orphan sweep makes a point of not making. The exit code is
    // the only artifact left once the host is gone, so it has to be honest.
    setTimeout(() => {
      const enginePid = engine.pid;
      let stillRunning = false;
      if (enginePid !== undefined && engine.exitCode === null && engine.signalCode === null) {
        try {
          process.kill(enginePid, 0);
          stillRunning = true;
        } catch {
          stillRunning = false;
        }
      }
      if (stillRunning) {
        report(`supervisor: engine ${String(enginePid)} survived the stop chain\n`);
        process.exit(5);
      }
      process.exit(0);
    }, 250).unref?.();
  }, 3_000);
  force.unref?.();
}

/**
 * Kill anything still in this process's group, except this process.
 *
 * The direct child exiting does NOT mean the tree is gone. Real engines are
 * reached through wrappers, and a wrapper can exit while the process it spawned
 * keeps running — a descendant that ignores SIGTERM outlives its own parent
 * exactly this way. Whatever remains in the group is by definition something
 * this watchdog spawned and nobody else will clean up.
 */
function reapGroupLeftovers() {
  try {
    // -A because these processes are detached and share no terminal with us.
    const listing = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' });
    for (const line of listing.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      if (pgid !== process.pid || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no ps, or nothing to enumerate; the group signal was the main attempt */
  }
}

engine.on('exit', (code, signal) => {
  // Sweep the group before reporting, so the watchdog never exits leaving
  // behind a descendant that outlived the child it was watching.
  reapGroupLeftovers();
  process.exit(signal ? 0 : (code ?? 0));
});
engine.on('error', (error) => {
  report(`supervisor: engine failed to start: ${error.message}\n`);
  process.exit(3);
});

// fd 3 is the watchdog pipe. Its read end never carries data — only the EOF
// that says the host's write end is gone.
try {
  const watchdog = new (await import('node:net')).Socket({ fd: 3, readable: true, writable: false });
  watchdog.on('end', () => stopEngine('SIGTERM'));
  watchdog.on('close', () => stopEngine('SIGTERM'));
  watchdog.on('error', () => stopEngine('SIGTERM'));
  watchdog.resume();
} catch (error) {
  report(`supervisor: watchdog pipe unavailable: ${String(error)}\n`);
  process.exit(4);
}

// A supervisor that is itself signalled must not leave the engine behind.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => stopEngine('SIGTERM'));
}
