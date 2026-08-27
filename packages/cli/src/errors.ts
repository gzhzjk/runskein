/**
 * Error formatter and exit-code classification.
 *
 * One formatter for everything the CLI prints as an error. Field-driven:
 * runskein typed errors are recognized by class and printed with
 * every own enumerable field, so each class is covered without per-class
 * code. `cause` chains are recursed (cycle-guarded); AggregateError leaves
 * are formatted individually and drive classification recursively.
 */
import {
  CancelledError,
  ConfigError,
  EngineCrashError,
  EngineOperationError,
  EngineStartError,
  NotFoundError,
  NotInstalledError,
  NotSupportedError,
  StoreError,
  UnauthenticatedError,
} from '@runskein/core';

/** CLI usage error (unknown flag/command, bad key=value) — exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Membership in this list is what makes something a "runskein typed error". */
const RUNSKEIN_ERROR_CLASSES: ReadonlyArray<new (...args: never[]) => Error> = [
  NotSupportedError,
  NotInstalledError,
  UnauthenticatedError,
  NotFoundError,
  EngineStartError,
  StoreError,
  EngineCrashError,
  CancelledError,
  ConfigError,
  EngineOperationError,
];

/**
 * Narrow a value to one of the runskein typed error classes.
 * @param e - the value to test.
 * @returns true when it is a runskein typed error.
 */
export function isRunskeinError(e: unknown): e is Error {
  return RUNSKEIN_ERROR_CLASSES.some((cls) => e instanceof cls);
}

export type ExitCode = 0 | 1 | 2 | 3;

/**
 * Classify a top-level failure: 1 for a runskein typed error, 3 for anything
 * else. A typed error is a classification boundary — its cause is displayed
 * but never re-classified, so an unexpected inner error cannot turn an
 * expected failure into a CLI bug. An AggregateError is judged by its leaves:
 * any unknown leaf, or no leaves at all, makes the whole thing unknown.
 * @param e - the thrown value.
 * @returns the exit code.
 */
export function classifyThrowable(e: unknown): 1 | 3 {
  if (e instanceof AggregateError) {
    if (e.errors.length === 0) return 3;
    return e.errors.some((leaf) => classifyThrowable(leaf) === 3) ? 3 : 1;
  }
  return isRunskeinError(e) ? 1 : 3;
}

/**
 * Reduce several exit codes to the most severe one, ordered 3 > 2 > 1 > 0.
 * @param codes - the candidate codes.
 * @returns the worst code.
 */
export function worstExitCode(codes: Iterable<ExitCode>): ExitCode {
  let worst: ExitCode = 0;
  for (const code of codes) {
    if (code === 3) return 3;
    if (code > worst) worst = code;
  }
  return worst;
}

/** Render one error field, falling back to String() for unserializable values. */
function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Format a typed error's own enumerable fields, which is what lets one
 * formatter cover every error class without per-class code. `name` is skipped
 * because the constructors assign it — making it an own property — and it is
 * already printed as the class name; `cause` is rendered as a chain instead.
 * @param e - the error.
 * @returns the fields as a ` { k: v, … }` suffix, or an empty string.
 */
function ownFields(e: Error): string {
  const skip = new Set(['name', 'message', 'stack', 'cause']);
  const entries = Object.entries(e).filter(([key]) => !skip.has(key));
  if (entries.length === 0) return '';
  const body = entries.map(([k, v]) => `${k}: ${formatFieldValue(v)}`).join(', ');
  return ` { ${body} }`;
}

/** Prefix every line of text, used to nest a cause under its parent. */
function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

/**
 * Recursively format a cause chain, guarding against cycles.
 * @param cause - the cause to format.
 * @param seen - the visited objects.
 * @returns formatted lines.
 */
function formatCauseChain(cause: unknown, seen: Set<unknown>): string[] {
  if (cause === undefined || cause === null) return [];
  if (seen.has(cause)) return ['caused by: <cycle>'];
  return indent(formatThrowable(cause, seen), '  ')
    .split('\n')
    .map((line, i) => (i === 0 ? line.replace(/^\s*\[error\]/, 'caused by:') : line));
}

/**
 * Format one throwable (runskein typed, AggregateError, or unknown).
 * @param e - the throwable.
 * @param seen - the cycle guard.
 * @returns its text.
 */
function formatThrowable(e: unknown, seen: Set<unknown>): string {
  if (e instanceof UsageError) return `[error] ${e.message}`;
  if (e instanceof AggregateError) {
    seen.add(e);
    const lines = [`[error] AggregateError: ${e.message}`];
    for (const inner of e.errors) {
      lines.push(seen.has(inner) ? '  <cycle>' : indent(formatThrowable(inner, seen), '  '));
    }
    if (e.errors.length === 0) lines.push('  (empty)');
    const causeLines = e.cause !== undefined ? formatCauseChain(e.cause, seen) : [];
    return [...lines, ...causeLines].join('\n');
  }
  if (isRunskeinError(e)) {
    seen.add(e);
    const lines = [`[error] ${e.name}: ${e.message}${ownFields(e)}`];
    lines.push(...formatCauseChain((e as { cause?: unknown }).cause, seen));
    return lines.join('\n');
  }
  if (e instanceof Error) {
    seen.add(e);
    const lines = [`[error] unexpected: ${e.name}: ${e.message}`];
    if (e.stack) lines.push(indent(e.stack, '  '));
    lines.push(...formatCauseChain(e.cause, seen));
    return lines.join('\n');
  }
  return `[error] unexpected: ${formatFieldValue(e)}`;
}

/**
 * Format any throwable for stderr. RunSkein typed errors render as
 * `[error] <ClassName>: <message> { …fields }` with an indented `caused by:`
 * chain; anything else renders as `unexpected:` plus its stack, so a CLI bug
 * or a leaked untyped error stays distinguishable from an expected failure.
 * @param e - the thrown value.
 * @returns the formatted text.
 */
export function formatError(e: unknown): string {
  return formatThrowable(e, new Set());
}
