import { UsageError } from './errors.js';

export interface ConfigAssignment {
  key: string;
  value: string | boolean;
}

/**
 * Parse the CLI's shared `key=value` syntax. Only the literals `true` and
 * `false` become booleans; everything else stays a string, so a value that
 * merely looks numeric reaches the engine unchanged.
 * @param input - the raw `key=value` argument.
 * @param usageMessage - the message for a malformed assignment.
 * @returns the parsed key and value.
 * @throws UsageError when the input has no key before its '='.
 */
export function parseConfigAssignment(input: string, usageMessage: string): ConfigAssignment {
  const eq = input.indexOf('=');
  if (eq <= 0) throw new UsageError(usageMessage);
  const raw = input.slice(eq + 1);
  return {
    key: input.slice(0, eq),
    value: raw === 'true' ? true : raw === 'false' ? false : raw,
  };
}
