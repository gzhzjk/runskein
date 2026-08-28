/**
 * Engine ownership registry and the orphan sweep.
 *
 * Engines are spawned into their own process group so lifecycle signals reach
 * every descendant, and that deliberately severs the parent-death link: a host
 * killed with SIGKILL leaks whatever it was running. Recovering from that needs
 * an answer to "who owned this process, and is that owner still alive?", and
 * the answer has to survive the owner's death — so it lives on disk.
 *
 * The obvious alternative, stamping ownership into the child's environment, was
 * rejected: reading another process's environment needs `ps -E` (macOS,
 * repeatedly tightened) or `/proc/<pid>/environ` (Linux), both same-uid-or-root
 * and non-portable, so a sweep could not reliably read its own marker.
 *
 * Concurrency: several hosts share one registry file. Writes are append-only,
 * and compaction rewrites via a temporary file plus rename. An append that
 * lands between a compaction's read and its rename is lost, which is the safe
 * direction to fail — a forgotten engine may leak once, whereas a phantom entry
 * could get a live process killed.
 *
 * Compaction is read-modify-write, so two of them racing *within one host* is a
 * different and unsafe case: both read the same table, each drops only its own
 * pid, and the later rename discards the earlier removal. Every engine exiting
 * at once — the ordinary shape of `hub.quit()` — hits exactly that. So
 * compactions are serialized per registry instance and drain a shared pending
 * set, and each one writes through a temporary name carrying a monotonic
 * counter: `pid` plus a millisecond timestamp collides when two engines exit in
 * the same tick, which made one writer rename a file the other had already
 * moved.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

/** One engine process and the host that launched it. */
export interface OwnershipEntry {
  /** Process group leader runskein spawned: the engine, or its supervisor. */
  enginePid: number;
  engineId: string;
  /** The host process that owns it; its death is what makes this an orphan. */
  ownerPid: number;
  /** Launch command recorded at spawn, checked before killing to guard pid reuse. */
  argv0: string;
  startedAt: number;
}

/** What one sweep did, for the internal observability seam. */
export interface OrphanSweepResult {
  /** Registry entries examined. */
  scanned: number;
  /** Orphaned engine processes signalled. */
  reaped: number;
  /** Entries dropped because their process was gone or was no longer ours. */
  prunedStaleEntries: number;
}

/**
 * Default registry location, kept out of any working tree so a repo checkout
 * never carries another machine's pids.
 * @returns the path to the shared ownership registry file.
 */
export function defaultRegistryPath(): string {
  const base =
    process.env['XDG_STATE_HOME'] ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.local', 'state'));
  return join(base, 'runskein', 'engines.jsonl');
}

/**
 * Carry a pre-rename registry into the current one, once.
 *
 * The product was renamed from realm-node to runskein (ADR 039), and this file
 * moved with it. Anything a host recorded before that upgrade sits in the old
 * directory, where the sweep no longer looks — so an engine leaked across the
 * upgrade would never be reaped, which is a real leak rather than a
 * hypothetical one.
 *
 * Entries are appended rather than the file moved, because by the time a host
 * upgrades both files can already exist: a "move only if the target is absent"
 * guard would silently do nothing in exactly that case. The legacy file is
 * removed afterwards, which is what makes a second call a no-op.
 *
 * Failure is deliberately silent. A registry that could not be migrated leaves
 * the sweep exactly as blind as it was before this function existed, whereas
 * throwing here would take down every hub on a machine over a stale file it
 * does not need.
 *
 * TODO(ADR 039): delete this and its three cases before 1.0. It is written to
 * be deletable — one call site, no other reader of the legacy path.
 *
 * @param target - the current registry path; its parent directory names the
 *   product, and the legacy path is the sibling named `realm-node`.
 * @returns the number of entries carried over; 0 when there was nothing to do.
 */
export function migrateLegacyRegistry(target: string): number {
  const legacy = join(dirname(dirname(target)), 'realm-node', basename(target));
  try {
    if (legacy === target || !existsSync(legacy)) return 0;
    const text = readFileSync(legacy, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length > 0) {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, `${lines.join('\n')}\n`);
    }
    unlinkSync(legacy);
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Test whether a pid is currently alive.
 *
 * `EPERM` counts as alive: the process exists but belongs to another user, and
 * treating "not mine" as "gone" would let a sweep prune an entry it should have
 * left alone.
 * @param pid - the process id to probe.
 * @returns true when a process with that id exists.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What `ps` reports about a live process. */
export interface ProcessInfo {
  command: string;
  /** Seconds the process has been running, from `ps -o etime=`. */
  elapsedSeconds: number;
}

/**
 * Parse an `etime` field: `[[dd-]hh:]mm:ss`.
 * @param value - the raw field.
 * @returns elapsed seconds, or undefined when unparseable.
 */
function parseElapsed(value: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/**
 * Read a live process's command line and age in one call.
 *
 * Both fields come from a single `ps` invocation deliberately: reading them
 * separately would leave a window in which the pid could be recycled between
 * the two reads, and the whole point of pairing them is to identify one
 * specific process.
 * Exported for diagnosis rather than for use: `identityMatches` returns a
 * verdict and discards what it read, so a test that sees the wrong verdict has
 * no way to say which of the two checks produced it. Nothing outside this file
 * and its tests should call it — the verdict is the contract.
 * @param pid - the process to inspect.
 * @returns its command line and elapsed time, or undefined when unreadable.
 */
export async function readProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  if (process.platform === 'win32') return undefined;
  return new Promise((resolve) => {
    // -ww disables width-based truncation. Output here has no tty, so ps does
    // not truncate today, but that is a default rather than a guarantee — and a
    // silently shortened command line would break the identity check below in
    // whichever direction the truncation happened to fall.
    execFile(
      'ps',
      ['-ww', '-p', String(pid), '-o', 'etime=,command='],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const text = stdout.trim();
        const split = /^(\S+)\s+([\s\S]*)$/.exec(text);
        if (!split) return resolve(undefined);
        const elapsedSeconds = parseElapsed(split[1]!);
        if (elapsedSeconds === undefined) return resolve(undefined);
        resolve({ command: split[2]!.trim(), elapsedSeconds });
      },
    );
  });
}

/**
 * How much a process's observed start time may differ from the recorded one.
 *
 * `ps` reports elapsed time to the second and the recording happens just after
 * `spawn()` returns, so a genuine match is off by well under a second. The
 * allowance is for clock adjustments and rounding, not for uncertainty: a
 * recycled pid would have to be reissued within this window to slip through,
 * which needs the entire pid space to wrap in half a minute.
 */
export const START_TIME_TOLERANCE_MS = 30_000;

/** Whether a live pid is the process the registry recorded, or cannot be told. */
export type IdentityVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * Decide whether a live pid is still the process an entry describes.
 *
 * Two independent checks, because neither alone is sufficient. The command line
 * alone is not an identity: every host running the same engine launches a
 * byte-identical one, so a recycled pid belonging to a *different host's live
 * engine* would match it perfectly. The start time is what makes the check
 * about one specific process — pid plus start time is the classic process
 * identity, and the registry records `startedAt` precisely for this.
 *
 * `unknown` is deliberately distinct from `mismatch`: not being able to read a
 * process is not evidence about it, and treating the two the same would let an
 * unreadable process's record be discarded while the process kept running.
 * @param pid - the live process id.
 * @param entry - the registry record being checked.
 * @returns match, mismatch, or unknown when the process cannot be inspected.
 */
export async function identityMatches(pid: number, entry: OwnershipEntry): Promise<IdentityVerdict> {
  const info = await readProcessInfo(pid);
  if (info === undefined || info.command === '') return 'unknown';
  if (!info.command.includes(entry.argv0)) return 'mismatch';
  // A record without a usable timestamp cannot be tied to one process, and the
  // command line alone is not enough to authorise a kill.
  if (!Number.isFinite(entry.startedAt) || entry.startedAt <= 0) return 'unknown';
  const observedStartedAt = Date.now() - info.elapsedSeconds * 1_000;
  const drift = Math.abs(observedStartedAt - entry.startedAt);
  return drift <= START_TIME_TOLERANCE_MS ? 'match' : 'mismatch';
}

/** Persistent record of which host owns which engine process. */
export interface OwnershipRegistry {
  /**
   * Record a freshly spawned engine.
   * @param entry - the engine, its owner, and its launch signature.
   */
  add(entry: OwnershipEntry): Promise<void>;
  /**
   * Forget an engine runskein stopped on purpose.
   * @param enginePid - the process that was stopped.
   */
  remove(enginePid: number): Promise<void>;
  /**
   * Read every recorded entry.
   * @returns the entries currently on file.
   */
  list(): Promise<OwnershipEntry[]>;
  /**
   * Drop the given engine pids from the file in one rewrite.
   * @param enginePids - the pids to forget.
   */
  compact(enginePids: readonly number[]): Promise<void>;
}

/**
 * Validate one parsed registry line.
 * @param value - the parsed JSON value.
 * @returns the entry, or undefined when the line is not a usable record.
 */
function parseEntry(value: unknown): OwnershipEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { enginePid, engineId, ownerPid, argv0, startedAt } = raw;
  if (typeof enginePid !== 'number' || typeof ownerPid !== 'number') return undefined;
  if (typeof engineId !== 'string' || typeof argv0 !== 'string') return undefined;
  return {
    enginePid,
    engineId,
    ownerPid,
    argv0,
    startedAt: typeof startedAt === 'number' ? startedAt : 0,
  };
}

/** Serialization state for one registry path, shared process-wide. */
interface CompactionState {
  /** Removals owed but not yet written. */
  pendingDrop: Set<number>;
  /** Tail of the compaction chain for this path. */
  compactions: Promise<void>;
}

const compactionStates = new Map<string, CompactionState>();

/**
 * The serialization state for a registry path, created on first use.
 * @param path - registry file path.
 * @returns the state every instance on that path shares.
 */
function compactionStateFor(path: string): CompactionState {
  let state = compactionStates.get(path);
  if (!state) {
    state = { pendingDrop: new Set(), compactions: Promise.resolve() };
    compactionStates.set(path, state);
  }
  return state;
}

let temporaryCounter = 0;

/**
 * A suffix unique within this process, so no two scratch files can share a name.
 *
 * Process-wide rather than per-instance on purpose: pid and millisecond are
 * identical across instances, so a per-instance counter reproduces the very
 * collision it is meant to prevent.
 * @returns the next suffix.
 */
function nextTemporarySuffix(): number {
  temporaryCounter += 1;
  return temporaryCounter;
}

/**
 * Create the on-disk ownership registry.
 * @param path - registry file path; defaults to the user state directory.
 * @returns a registry backed by an append-only JSONL file.
 */
export function fileOwnershipRegistry(path: string = defaultRegistryPath()): OwnershipRegistry {
  // Only the default path has a legacy twin; a caller-supplied path is its own.
  if (path === defaultRegistryPath()) migrateLegacyRegistry(path);
  let dirReady: Promise<unknown> | undefined;
  const ensureDir = (): Promise<unknown> => (dirReady ??= mkdir(dirname(path), { recursive: true }));

  const readAll = async (): Promise<OwnershipEntry[]> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: OwnershipEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = parseEntry(JSON.parse(line) as unknown);
        if (entry) entries.push(entry);
      } catch {
        // A concurrent append can leave a torn final line; the next writer
        // completes it, and a record we cannot read is one we must not act on.
      }
    }
    return entries;
  };

  // Shared with every other instance on this path in this process: two hubs in
  // one host is ordinary, and per-instance state would leave them racing each
  // other exactly as unserialized compactions did.
  const shared = compactionStateFor(path);

  /** Rewrite the file without whatever has accumulated in the pending set. */
  const drainPending = async (): Promise<void> => {
    if (shared.pendingDrop.size === 0) return;
    const drop = shared.pendingDrop;
    shared.pendingDrop = new Set();
    try {
      const kept = (await readAll()).filter((entry) => !drop.has(entry.enginePid));
      await ensureDir();
      const temporary = `${path}.${process.pid}.${Date.now()}.${nextTemporarySuffix()}.tmp`;
      try {
        await writeFile(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      // The removals never landed, so they are still owed. Re-queueing lets the
      // next compaction retry them instead of leaving a phantom entry behind.
      for (const enginePid of drop) shared.pendingDrop.add(enginePid);
      throw error;
    }
  };

  const compact = (enginePids: readonly number[]): Promise<void> => {
    if (enginePids.length === 0) return Promise.resolve();
    for (const enginePid of enginePids) shared.pendingDrop.add(enginePid);
    // Chained on both settlements: one caller's failure must not strand the
    // next caller's removal. A run that finds the set already drained by an
    // earlier link resolves immediately — its pids did land.
    const run = shared.compactions.then(drainPending, drainPending);
    shared.compactions = run.catch(() => undefined);
    return run;
  };

  return {
    async add(entry: OwnershipEntry): Promise<void> {
      await ensureDir();
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    remove: (enginePid: number) => compact([enginePid]),
    list: readAll,
    compact,
  };
}

/**
 * Stops an orphaned process tree.
 * @returns true when the process is actually gone afterwards.
 */
export type OrphanReaper = (enginePid: number) => Promise<boolean>;

/**
 * Reap engine processes whose owning host is gone.
 *
 * A process is killed only when all of these hold: its owner is dead, it is
 * itself alive, and it is still identifiably the process the entry describes
 * (command line AND start time). Anything else is either another host's live
 * engine, a recycled pid, or a process that cannot be inspected — none of
 * which may be killed.
 *
 * A process is killed only when all three hold: its owner is dead, it is
 * itself alive, and its command line still matches what runskein recorded. Any
 * one of those failing means either someone else's live engine or a reused
 * pid, and the entry is pruned instead.
 * @param registry - the ownership registry to read and compact.
 * @param reap - stops one orphaned process tree.
 * @returns counts of what was scanned, reaped, and pruned.
 */
export async function sweepOrphans(
  registry: OwnershipRegistry,
  reap: OrphanReaper,
): Promise<OrphanSweepResult> {
  const entries = await registry.list();
  const result: OrphanSweepResult = { scanned: entries.length, reaped: 0, prunedStaleEntries: 0 };
  const forget: number[] = [];

  for (const entry of entries) {
    if (!isPidAlive(entry.enginePid)) {
      // The engine is gone; the record is the only thing left of it.
      forget.push(entry.enginePid);
      result.prunedStaleEntries++;
      continue;
    }
    // A live owner means a live host is using this engine — never ours to kill,
    // even though the engine looks identical to an orphan from the outside.
    if (isPidAlive(entry.ownerPid)) continue;
    const verdict = await identityMatches(entry.enginePid, entry);
    if (verdict === 'unknown') {
      // Cannot inspect it, so cannot authorise a kill — and must not discard
      // the record either: dropping it would leave a running process with
      // nothing left to identify it, permanently untrackable. Leave it for a
      // later sweep, which may be able to read it.
      continue;
    }
    if (verdict === 'mismatch') {
      // This pid is no longer the process the entry describes; the record is
      // about something that has already gone.
      forget.push(entry.enginePid);
      result.prunedStaleEntries++;
      continue;
    }
    if (await reap(entry.enginePid)) {
      forget.push(entry.enginePid);
      result.reaped++;
      continue;
    }
    // It survived the stop chain. Keeping the record is the point: reporting it
    // as reaped would overstate what happened, and forgetting it would mean no
    // later sweep ever tries again.
  }

  await registry.compact(forget);
  return result;
}
