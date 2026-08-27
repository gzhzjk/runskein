#!/usr/bin/env tsx
/**
 * runskein — interactive engine test CLI.
 *
 * Dev/verification tool over the public API only: createHub + Hub + Session.
 * The built-in adapters are registered explicitly and auto-discovery is
 * disabled, so the CLI never imports adapter code from the cwd; the
 * repeatable global `--adapter-path <dir>` opts a trusted directory into
 * scanning for discovery testing.
 *
 * Exit codes: 0 success · 1 runskein typed error · 2 CLI usage error ·
 * 3 unexpected throwable. Every command runs the idempotent cleanup.
 */
import { resolve } from 'node:path';
import { createHub, jsonlStore, type Hub, type HubOptions } from '@runskein/core';
import claudeCode from '@runskein/adapter-claude-code';
import codex from '@runskein/adapter-codex';
import kimi from '@runskein/adapter-kimi';
import opencode from '@runskein/adapter-opencode';
import pi from '@runskein/adapter-pi';
import { runChat, type ChatOptions } from './chat.js';
import { parseConfigAssignment } from './config.js';
import { UsageError, classifyThrowable, formatError, worstExitCode, type ExitCode } from './errors.js';
import {
  getOutputFailure,
  outputClosed,
  printErr,
  printLine,
  renderDescribe,
  renderEngines,
} from './render.js';
import { Shutdown } from './shutdown.js';

const USAGE = `usage: runskein [--adapter-path <dir>]... <command> [options]

commands:
  engines                                    list discovered engines (installed/version/auth/health)
  describe <engineId> [--refresh]            show config options, modes, capabilities
  chat <engineId> [options]                  start the engine and chat in a REPL

chat options:
  --cwd <dir>                                session working directory (default: cwd)
  -c key=value                               engine config; repeatable; booleans take true/false
  --resume <sessionId>                       resume a previous session
  --permission allow-all|deny-all|ask        permission policy (default: allow-all)

repl commands: :cancel  :config key=value  :fork  :status  :quit`;

// ── argument parsing (by hand — the surface is tiny) ───────────────────

interface GlobalArgs {
  adapterPaths: string[];
  command: string;
  rest: string[];
}

/**
 * Parse the flags that precede the command, stopping at the command itself.
 * @param argv - the raw CLI arguments.
 * @returns the adapter paths, the command, and its remaining arguments.
 * @throws UsageError on an unknown global flag or a missing command.
 */
function parseGlobal(argv: string[]): GlobalArgs {
  const adapterPaths: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    // `pnpm dev -- <args>` forwards a literal separator; ignore it.
    if (arg === '--') continue;
    if (arg === '--adapter-path') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--adapter-path requires a directory');
      adapterPaths.push(value);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown global flag '${arg}'`);
    } else {
      return { adapterPaths, command: arg, rest: argv.slice(i + 1) };
    }
  }
  throw new UsageError('no command given');
}

interface DescribeArgs {
  engineId: string;
  refresh: boolean;
}

type CommandArgs =
  { kind: 'engines' } | { kind: 'describe'; args: DescribeArgs } | { kind: 'chat'; args: ChatOptions };

/**
 * Read the value following a flag that needs one.
 * @param rest - the remaining arguments.
 * @param i - the current index (of the flag).
 * @param flag - the flag name for the error message.
 * @returns the next argument.
 * @throws UsageError when the value is missing.
 */
function requireValue(rest: string[], i: number, flag: string): string {
  const value = rest[i + 1];
  if (value === undefined) throw new UsageError(`${flag} requires a value`);
  return value;
}

/**
 * Parse `chat` subcommand options (engine, cwd, permission mode, resume).
 * @param rest - arguments after the chat command.
 * @returns the parsed chat options.
 * @throws UsageError on unknown options.
 */
function parseChatArgs(rest: string[]): ChatOptions {
  let engineId: string | undefined;
  let cwd: string | undefined;
  let resume: string | undefined;
  let permission: ChatOptions['permission'] = 'allow-all';
  const config: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--cwd') {
      cwd = requireValue(rest, i, '--cwd');
      i++;
    } else if (arg === '-c') {
      const kv = requireValue(rest, i, '-c');
      i++;
      const assignment = parseConfigAssignment(kv, `bad -c '${kv}' — expected key=value`);
      config[assignment.key] = assignment.value;
    } else if (arg === '--resume') {
      resume = requireValue(rest, i, '--resume');
      i++;
    } else if (arg === '--permission') {
      const value = requireValue(rest, i, '--permission');
      i++;
      if (value !== 'allow-all' && value !== 'deny-all' && value !== 'ask') {
        throw new UsageError(`bad --permission '${value}' — allow-all|deny-all|ask`);
      }
      permission = value;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown chat flag '${arg}'`);
    } else if (engineId === undefined) {
      engineId = arg;
    } else {
      throw new UsageError(`unexpected argument '${arg}'`);
    }
  }
  if (engineId === undefined) throw new UsageError('chat requires an <engineId>');
  return {
    engineId,
    cwd: resolve(cwd ?? process.cwd()),
    config,
    ...(resume !== undefined ? { resume } : {}),
    permission,
  };
}

/**
 * Dispatch the first non-flag argument to its command parser.
 * @param global - the parsed global options.
 * @returns the parsed command.
 * @throws UsageError for an unknown command.
 */
function parseCommand(global: GlobalArgs): CommandArgs {
  const { command, rest } = global;
  switch (command) {
    case 'engines': {
      if (rest.length > 0) throw new UsageError(`engines takes no arguments, got '${rest[0]}'`);
      return { kind: 'engines' };
    }
    case 'describe': {
      let engineId: string | undefined;
      let refresh = false;
      for (const arg of rest) {
        if (arg === '--refresh') refresh = true;
        else if (arg.startsWith('-')) throw new UsageError(`unknown describe flag '${arg}'`);
        else if (engineId === undefined) engineId = arg;
        else throw new UsageError(`unexpected argument '${arg}'`);
      }
      if (engineId === undefined) throw new UsageError('describe requires an <engineId>');
      return { kind: 'describe', args: { engineId, refresh } };
    }
    case 'chat':
      return { kind: 'chat', args: parseChatArgs(rest) };
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

// ── dispatcher (cleanup after every command, on every exit path) ───────

/**
 * Map a thrown value to a process exit code.
 * @param e - the thrown value.
 * @returns 2 for usage errors, else the runskein/unknown classification.
 */
function exitCodeOf(e: unknown): ExitCode {
  return e instanceof UsageError ? 2 : classifyThrowable(e);
}

/**
 * Top-level command dispatch; every command converges on idempotent cleanup.
 * @param argv - the process arguments after the binary name.
 * @returns the exit code.
 */
async function main(argv: string[]): Promise<ExitCode> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    printLine(USAGE);
    return 0;
  }

  let global: GlobalArgs;
  let command: CommandArgs;
  try {
    global = parseGlobal(argv);
    command = parseCommand(global);
  } catch (e) {
    if (e instanceof UsageError) {
      printErr(`[error] ${e.message}`);
      printErr(USAGE);
      return 2;
    }
    throw e;
  }

  for (const dir of global.adapterPaths) {
    printErr(
      `[warn] --adapter-path imports and executes adapter code from ${resolve(dir)} — use only with trusted directories`,
    );
  }

  const hubOptions: HubOptions = {
    // Explicit registration is the highest-priority layer; discovery is
    // disabled so nothing is imported from the cwd.
    adapters: [opencode, kimi, claudeCode, codex, pi],
    discovery: false,
  };
  if (global.adapterPaths.length > 0) {
    hubOptions.adapterPaths = global.adapterPaths.map((dir) => resolve(dir));
  }
  if (command.kind === 'chat') {
    // Transcripts land next to the tested project.
    hubOptions.store = jsonlStore(resolve(command.args.cwd, '.transcripts'));
  }
  const hub: Hub = createHub(hubOptions);
  const shutdown = new Shutdown(hub);

  const codes: ExitCode[] = [];
  const recordFailure = (e: unknown): void => {
    printErr(formatError(e));
    codes.push(exitCodeOf(e));
  };

  // Non-chat commands: SIGINT/SIGTERM route into the same idempotent cleanup.
  // chat installs its own handlers (active-state SIGINT only cancels).
  const onSignal = (): void => void shutdown.run();
  if (command.kind !== 'chat') {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  let commandError: unknown;
  try {
    switch (command.kind) {
      case 'engines':
        printLine(renderEngines(await hub.engines()));
        break;
      case 'describe': {
        const { engineId, refresh } = command.args;
        if (refresh) await hub.rescan();
        printLine(renderDescribe(engineId, await hub.describe(engineId)));
        break;
      }
      case 'chat':
        await runChat(hub, command.args, { shutdown, recordFailure, outputClosed });
        break;
    }
  } catch (e) {
    commandError = e;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  // Cleanup is separate from the command error: a command is not successful
  // until cleanup completes, and cleanup never masks the original failure.
  await shutdown.run();

  if (commandError !== undefined) recordFailure(commandError);
  for (const e of shutdown.errors) recordFailure(e);
  const outputFailure = getOutputFailure();
  if (outputFailure !== undefined) recordFailure(outputFailure);
  return worstExitCode(codes);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  // Last-resort guard: main() itself failing is a CLI bug (code 3).
  printErr(formatError(e));
  process.exitCode = 3;
}
