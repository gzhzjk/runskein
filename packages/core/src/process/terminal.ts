/**
 * Terminals the client runs on the agent's behalf.
 *
 * Some engines execute commands in their own process; others delegate to the
 * client through ACP's `terminal/*` methods. When a client declines that
 * capability, an engine of the second kind cannot run a command at all — kimi
 * fails every command tool with "ACP terminal capability is unavailable" — so
 * declining it is not a neutral choice, it decides which engines can work.
 *
 * Running a command for the agent puts runskein in the position of executing what
 * the model asked for, which is exactly the position the permission policy
 * exists to govern. Two boundaries are therefore enforced here rather than
 * trusted to the request:
 *
 * - every terminal is created through the session's PermissionPolicy;
 * - the working directory may be narrowed within the session's cwd, never
 *   moved outside it, whatever path the agent asks for;
 * - the environment the agent supplies may not decide which program the
 *   allowed command actually is.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ENV_SCRUB_PATTERNS, matchesEnvName, mergeEnv, scrubEnv, stopTreeByPid } from './spawn.js';

/** Output retained per terminal when the agent names no limit: 1 MiB. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
/**
 * Ceiling on what an agent may ask the client to retain: 16 MiB.
 *
 * The limit is the agent's to choose, but it chooses how much memory this
 * process holds, and an engine asking for a gigabyte of build log should not be
 * able to take the host down with it.
 */
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024;
/**
 * The retention limit a request actually gets.
 *
 * Total on purpose. `Math.min(x, MAX)` is `NaN` for any non-numeric `x`, and
 * every comparison against `NaN` is false — so the truncation loop below would
 * neither return early nor trim, and the buffer would grow without bound while
 * reporting itself truncated. The ceiling exists to stop exactly that, so the
 * function that applies it may not have an input that defeats it.
 *
 * The wire boundary refuses a non-numeric limit before a process is created;
 * this is the second line, for callers that reach `SessionTerminals` directly
 * through `@runskein/core/internal`.
 *
 * A fractional limit is floored rather than refused: the wire check accepts
 * `1.9` because a fractional byte count can still be honoured, and honouring it
 * means keeping no more than 1 byte.
 *
 * @param requested - the agent's requested limit, or null/undefined for the default.
 * @returns a finite whole byte count between 1 and the ceiling.
 */
function clampOutputByteLimit(requested: number | null | undefined): number {
  if (requested === null || requested === undefined) return DEFAULT_OUTPUT_BYTE_LIMIT;
  if (!Number.isFinite(requested)) return DEFAULT_OUTPUT_BYTE_LIMIT;
  return Math.max(1, Math.min(Math.floor(requested), MAX_OUTPUT_BYTE_LIMIT));
}

/** Grace between asking a command to stop and killing it outright. */
const KILL_GRACE_MS = 2_000;

/** A POSIX environment variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment variables an agent may not set on a terminal.
 *
 * A permission rule allows a *command*, and these variables decide what that
 * command turns out to be: `PATH` picks which binary runs, the loader and
 * runtime variables inject code into whichever one does. A host that allowed
 * `git status` would otherwise have authorised a name rather than a program.
 *
 * They are refused rather than quietly dropped: an agent that needs one is
 * asking for something the host has to decide, and a silent drop would leave
 * the command running under an environment nobody asked for.
 */
const ENV_DENY_PATTERNS: readonly RegExp[] = [
  /^PATH$/,
  /^(LD|DYLD)_/,
  /^NODE_(OPTIONS|PATH|REPL_EXTERNAL_MODULE)$/,
  /^PYTHON(PATH|HOME|STARTUP)$/,
  /^(PERL5LIB|PERL5OPT|RUBYLIB|RUBYOPT|CLASSPATH)$/,
  /^(JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/,
  /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS)$/,
  /^BASH_FUNC_/,
  /^GIT_(SSH|SSH_COMMAND|EXTERNAL_DIFF|PROXY_COMMAND|CONFIG_|ALTERNATE_OBJECT_DIRECTORIES)/,
];

/**
 * Check the environment overrides an agent asked a terminal to run with.
 *
 * Called before the permission policy as well as at spawn time, so the policy
 * sees the override entries the child's environment is built from — layered
 * there over the scrubbed host one — and never has to reason about an override
 * that would later be rejected. Entries are returned in the order they were
 * requested, one per name: a repeated name is refused, compared without case on
 * every platform, so that what a policy reads for a variable is the value the
 * command runs with wherever the session is hosted.
 * @param entries - the request's env, as ACP sends it.
 * @param extraScrub - the adapter's scrub patterns, as used for the engine itself.
 * @returns the entries, once every one of them is allowed.
 * @throws `Error` naming the first variable that is malformed, reserved,
 *   repeated, or refused.
 */
export function authorizeTerminalEnv(
  entries: readonly { name: string; value: string }[] | undefined,
  extraScrub: readonly RegExp[] = [],
): { name: string; value: string }[] {
  if (entries !== undefined && !Array.isArray(entries)) {
    throw new Error('terminal env must be an array of { name, value }');
  }
  const reserved = [...ENV_SCRUB_PATTERNS, ...extraScrub];
  const checked: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    const name = entry?.name;
    const value = entry?.value;
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new Error('terminal env entries must be { name, value } strings');
    }
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`invalid environment variable name '${name}'`);
    }
    if (value.includes('\0')) {
      throw new Error(`environment variable '${name}' contains a NUL byte`);
    }
    if (matchesEnvName(ENV_DENY_PATTERNS, name)) {
      throw new Error(`environment variable '${name}' may not be set on a terminal`);
    }
    // The markers scrubbed from the engine's own environment: letting the
    // agent put them back would undo the hygiene child agents start on.
    if (matchesEnvName(reserved, name)) {
      throw new Error(`environment variable '${name}' is reserved by the host`);
    }
    // A request that names one variable twice does not have a single meaning,
    // and every way of resolving it hides something from the policy: an exact
    // repeat collapses at spawn to the last value, and a case variant is one
    // variable on Windows and two on POSIX. Refused rather than resolved --
    // an agent setting a variable twice cannot mean both, and choosing for it
    // would decide what it asked. Compared without case on every platform, so
    // that what a request means does not depend on the host it reaches.
    const key = name.toUpperCase();
    if (seen.has(key)) {
      throw new Error(`environment variable '${name}' is set more than once`);
    }
    seen.add(key);
    checked.push({ name, value });
  }
  return checked;
}

export interface TerminalCreateParams {
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string | null;
  outputByteLimit?: number | null;
}

export interface TerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

export interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
}

interface TerminalRecord {
  child: ChildProcess;
  /** Retained output, already trimmed to the byte limit. */
  buffer: string;
  truncated: boolean;
  byteLimit: number;
  exit: TerminalExitStatus | undefined;
  exited: Promise<TerminalExitStatus>;
}

/**
 * The terminals of one session.
 *
 * One registry per session keeps the cwd boundary and the cleanup obligation
 * where the session is: a closed session must leave no command running.
 */
export class SessionTerminals {
  private readonly records = new Map<string, TerminalRecord>();
  private counter = 0;

  /**
   * @param sessionCwd - the session's working directory; every terminal runs at or below it.
   * @param envScrubExtra - adapter-specific env scrub patterns, as used for the engine itself.
   */
  constructor(
    private readonly sessionCwd: string,
    private readonly envScrubExtra: readonly RegExp[] = [],
    /** Called when a command finishes, so an owner can restart its idle clock. */
    private readonly onSettle: () => void = () => {},
  ) {}

  /**
   * Whether any command is still running.
   *
   * A session with a live terminal is not idle, whatever its turn queue says:
   * releasing the engine underneath a running command would strand it.
   * @returns true while at least one command has not exited.
   */
  hasRunning(): boolean {
    for (const record of this.records.values()) if (record.exit === undefined) return true;
    return false;
  }

  /**
   * Resolve the working directory for a terminal, refusing to leave the session.
   *
   * A relative path is taken against the session's cwd; an absolute one must be
   * inside it. The agent may narrow the boundary and may not move it.
   *
   * Containment is decided twice: once on the spelling, and once on the paths
   * the filesystem actually resolves to. Spelling alone is not a boundary — a
   * symlink under the session pointing anywhere on the disk reads as a
   * session-relative path and runs somewhere else. A directory that does not
   * exist is refused here rather than left to spawn, since there is nothing to
   * resolve and therefore nothing this check could be true about.
   * @param requested - the cwd the agent asked for, if any.
   * @returns the directory to run in.
   * @throws `Error` when the requested directory is outside the session's cwd,
   *   or does not exist.
   */
  resolveCwd(requested: string | null | undefined): string {
    if (requested === undefined || requested === null || requested === '') return this.sessionCwd;
    const target = isAbsolute(requested) ? resolve(requested) : resolve(this.sessionCwd, requested);
    const outside = (): Error => new Error(`cwd '${requested}' is outside the session's working directory`);
    const lexical = relative(resolve(this.sessionCwd), target);
    if (lexical.startsWith('..') || isAbsolute(lexical)) throw outside();
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      throw new Error(`cwd '${requested}' does not exist`);
    }
    // A session cwd that cannot be resolved leaves nothing to contain the
    // target: fall back to its spelling, which no existing real path is under.
    let root: string;
    try {
      root = realpathSync(this.sessionCwd);
    } catch {
      root = resolve(this.sessionCwd);
    }
    const inside = relative(root, real);
    if (inside.startsWith('..') || isAbsolute(inside)) throw outside();
    // The spelled path is what runs: it is the one the host's rules and the
    // agent both named, and spawn follows the same links this check just did.
    return target;
  }

  /**
   * Start a command and retain its output.
   *
   * The caller is responsible for having asked the permission policy first;
   * this method performs no policy check of its own, so there is exactly one
   * place where that decision is made.
   * @param params - the agent's create request.
   * @returns the id later calls address this terminal by.
   * @throws `Error` when the requested cwd escapes the session, or the request
   *   sets an environment variable an agent may not set.
   */
  create(params: TerminalCreateParams): string {
    const cwd = this.resolveCwd(params.cwd);
    const byteLimit = clampOutputByteLimit(params.outputByteLimit);
    const env = mergeEnv(
      scrubEnv(process.env, this.envScrubExtra),
      authorizeTerminalEnv(params.env, this.envScrubExtra),
    );
    // No shell: the agent supplies a command and an argument array, and turning
    // that back into a shell string would re-introduce quoting bugs the array
    // form exists to avoid.
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so killing a terminal takes the whole tree the
      // command started rather than only the command.
      detached: process.platform !== 'win32',
    });

    const id = `runskein-terminal-${++this.counter}`;
    let settle: (status: TerminalExitStatus) => void = () => {};
    const record: TerminalRecord = {
      child,
      buffer: '',
      truncated: false,
      byteLimit,
      exit: undefined,
      exited: new Promise<TerminalExitStatus>((res) => {
        settle = res;
      }),
    };

    const append = (text: string): void => {
      if (text === '') return;
      record.buffer += text;
      // The schema is explicit that the client truncates from the beginning:
      // the tail is what a caller reading a long build log needs.
      //
      // The limit is a hard ceiling, not a budget: it exists so an engine
      // asking for a gigabyte of build log cannot take the host down, and a
      // rule that may sit one character above its own maximum does not serve
      // that. Where the cut lands inside a character, the whole character
      // goes, so the result is at or under the limit and never over.
      // Measured before copied: `byteLength` scans, `Buffer.from` scans *and*
      // allocates the whole retained buffer. Under the limit — which is every
      // append until the command has produced more than the limit allows —
      // there is nothing to trim, so the copy would be pure waste on the path
      // that runs for every chunk of output.
      if (Buffer.byteLength(record.buffer) <= record.byteLimit) return;
      record.truncated = true;
      const bytes = Buffer.from(record.buffer, 'utf8');
      let start = bytes.length - record.byteLimit;
      // `start` is in [1, bytes.length) here — the early return above proves
      // `bytes.length > byteLimit`, so the subtraction is positive — which is
      // what makes the indexing below safe.
      //
      // A UTF-8 continuation byte is 10xxxxxx. Stepping forward off one lands
      // on a character boundary, which is what keeps a surrogate pair whole:
      // slicing by UTF-16 code units instead used to cut between the halves
      // of a non-BMP character and leave an unpaired surrogate at the front.
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      record.buffer = bytes.subarray(start).toString('utf8');
    };
    // One decoder per stream: a multi-byte character split across two chunks
    // would otherwise be decoded as two replacement characters, and command
    // output is exactly where that shows up (any non-ASCII path or message).
    // Ending the decoder with the stream turns a trailing partial sequence into
    // the replacement character a reader should see, rather than losing it.
    const pipe = (stream: NodeJS.ReadableStream | null | undefined): void => {
      if (!stream) return;
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
      stream.on('end', () => append(decoder.end()));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', (error) => {
      // A command that cannot start is reported through the terminal rather
      // than as a protocol failure: the agent asked to run something, and
      // "it did not run" is the answer to that question.
      append(`runskein: failed to start '${params.command}': ${error.message}\n`);
      record.exit = { exitCode: 127 };
      settle(record.exit);
      this.onSettle();
    });
    child.on('exit', (code, signal) => {
      record.exit = { exitCode: code, signal };
      settle(record.exit);
      this.onSettle();
    });

    this.records.set(id, record);
    return id;
  }

  /**
   * Read what a terminal has produced so far.
   * @param terminalId - the id from create().
   * @returns retained output, whether it was truncated, and the exit status when finished.
   * @throws `Error` when the id is unknown.
   */
  output(terminalId: string): TerminalOutput {
    const record = this.require(terminalId);
    return {
      output: record.buffer,
      truncated: record.truncated,
      ...(record.exit ? { exitStatus: record.exit } : {}),
    };
  }

  /**
   * Wait for a terminal's command to finish.
   * @param terminalId - the id from create().
   * @returns the exit status.
   * @throws `Error` when the id is unknown.
   */
  waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const record = this.require(terminalId);
    return record.exit ? Promise.resolve(record.exit) : record.exited;
  }

  /**
   * Stop a terminal's command, keeping its output readable.
   *
   * ACP separates kill from release for this reason: an agent that stopped a
   * command still wants to read what it printed before it was stopped.
   * @param terminalId - the id from create().
   * @returns resolves once the process is gone, or false if it outlived SIGKILL.
   * @throws `Error` when the id is unknown.
   */
  kill(terminalId: string): Promise<boolean> {
    return this.stop(this.require(terminalId));
  }

  /**
   * Stop a terminal and forget it.
   * @param terminalId - the id from create().
   * @returns resolves once the process is gone, or false if it outlived SIGKILL.
   */
  release(terminalId: string): Promise<boolean> {
    const record = this.records.get(terminalId);
    if (!record) return Promise.resolve(true); // releasing twice is not an error
    this.records.delete(terminalId);
    return this.stop(record);
  }

  /**
   * Release every terminal, for session close and engine teardown.
   *
   * A session that ends must not leave commands running: they were started on
   * the agent's behalf and nothing else will ever collect them.
   * @returns the ids of commands that survived being killed, which is a leak
   *   the caller should report rather than discard.
   */
  async releaseAll(): Promise<string[]> {
    const ids = [...this.records.keys()];
    const results = await Promise.all(ids.map(async (id) => ({ id, gone: await this.release(id) })));
    return results.filter((entry) => !entry.gone).map((entry) => entry.id);
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId);
    if (!record) throw new Error(`unknown terminal '${terminalId}'`);
    return record;
  }

  private stop(record: TerminalRecord): Promise<boolean> {
    if (record.exit !== undefined || record.child.pid === undefined) return Promise.resolve(true);
    // Same escalation the engine processes get — SIGTERM, then SIGKILL to the
    // whole group — because a command's children are as much this session's
    // responsibility as the command itself. Not awaited: a caller releasing a
    // terminal is not waiting for the shell to notice.
    return stopTreeByPid(record.child.pid, KILL_GRACE_MS);
  }
}
