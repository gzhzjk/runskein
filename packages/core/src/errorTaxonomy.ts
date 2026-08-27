/**
 * Adapter-declared engine error classification.
 *
 * Engine error wording belongs to the engine, so core only evaluates patterns
 * supplied by the selected adapter. An absent match is intentionally useful:
 * callers receive the ordinary operation error instead of a guessed cause.
 */
import type { EngineErrorKind } from './errors.js';
import type { EngineErrorPattern } from './types.js';

export type AdapterErrorCause = EngineErrorPattern['cause'];

export interface CompiledErrorPattern {
  cause: AdapterErrorCause;
  expression: RegExp;
}

/**
 * Compile declarative adapter patterns after schema validation.
 * @param patterns - adapter-owned patterns, in first-match-wins order.
 * @returns compiled patterns ready for request-boundary classification.
 * @throws SyntaxError when a pattern's expression or flags are invalid.
 */
export function compileErrorPatterns(
  patterns: readonly EngineErrorPattern[] | undefined,
): readonly CompiledErrorPattern[] {
  return (patterns ?? []).map((pattern) => ({
    cause: pattern.cause,
    expression: new RegExp(pattern.match, pattern.flags ?? 'i'),
  }));
}

/**
 * Find the first adapter-declared cause in an engine failure and its causes.
 * @param patterns - precompiled patterns in adapter declaration order.
 * @param failure - raw error returned by the ACP client.
 * @returns the recognised adapter cause, or undefined when no pattern matches.
 */
export function classifyEngineFailure(
  patterns: readonly CompiledErrorPattern[],
  failure: unknown,
): AdapterErrorCause | undefined {
  const messages = errorMessages(failure);
  for (const pattern of patterns) {
    for (const message of messages) {
      // global/sticky RegExp instances retain lastIndex between tests. Resetting
      // it keeps an adapter declaration deterministic across repeated failures.
      pattern.expression.lastIndex = 0;
      const matches = pattern.expression.test(message);
      pattern.expression.lastIndex = 0;
      if (matches) return pattern.cause;
    }
  }
  return undefined;
}

/**
 * Map adapter causes onto the frozen EngineOperationError discriminant.
 * @param cause - the adapter cause returned by classification.
 * @returns the public operation-error kind, or undefined for authentication.
 */
export function operationErrorKind(cause: AdapterErrorCause): EngineErrorKind | undefined {
  switch (cause) {
    case 'rate-limit':
      return 'rate-limit';
    case 'context':
      return 'context-exceeded';
    case 'internal':
      return 'internal';
    case 'auth':
      return undefined;
  }
}

function errorMessages(failure: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<object>();
  let current = failure;
  while (current !== undefined) {
    if (typeof current === 'string') {
      messages.push(current);
      break;
    }
    if (typeof current !== 'object' || current === null) break;
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as { message?: unknown; cause?: unknown };
    if (typeof value.message === 'string') messages.push(value.message);
    current = value.cause;
  }
  return messages;
}
