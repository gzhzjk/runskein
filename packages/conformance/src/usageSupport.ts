/**
 * Wire-side usage reading shared by UA-LIVE-01 (live case) and UA-MTX-01
 * (probe matrix row) — decision 033's "declaration is falsifiable" machinery.
 *
 * This module deliberately re-states core's built-in token alias table instead
 * of importing it: the live oracle must judge the captured wire independently
 * of runskein's own bookkeeping (the ST-QUOTA-02 rationale — comparing runskein's
 * parser against itself proves nothing), and core's internal seam does not
 * re-export the fold helpers. If the table here ever drifts from core's, a
 * real engine run fails loudly rather than silently.
 */

import type { EngineAdapter } from '@runskein/core';

/** RunSkein Usage key -> engine field names tried in order (numbers only). */
export const BUILTIN_TOKEN_FIELDS: Record<string, string[]> = {
  input: ['inputTokens', 'input'],
  output: ['outputTokens', 'output'],
  total: ['totalTokens', 'total'],
  uncached: ['uncachedTokens', 'uncached'],
  cacheRead: ['cacheReadTokens', 'cacheRead', 'cachedTokens'],
  cacheCreation: ['cacheCreationTokens', 'cacheCreation'],
  thought: ['thoughtTokens', 'thought'],
};

/** Adapter-declared alias names per runskein Usage key (`EngineAdapter['usage']['tokens']`). */
export type DeclaredTokenNames = Partial<Record<string, readonly string[]>> | undefined;

export interface UsageWireReading {
  /** RunSkein Usage keys that resolved to a finite number on this report. */
  fields: string[];
  /** The resolved numbers, keyed by runskein Usage key. */
  values: Record<string, number>;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Read runskein Usage keys off one usage report object. Declared aliases are
 * tried before the built-ins per key, first match wins — mirroring core's
 * resolution order without reusing its code.
 * @param report - one flat usage report object from the wire.
 * @param declared - the adapter's declared alias names, if any.
 * @returns which runskein keys resolved and their numbers.
 */
export function readTokenFields(
  report: Record<string, unknown>,
  declared?: DeclaredTokenNames,
): UsageWireReading {
  const values: Record<string, number> = {};
  for (const [key, builtins] of Object.entries(BUILTIN_TOKEN_FIELDS)) {
    for (const name of [...(declared?.[key] ?? []), ...builtins]) {
      const value = report[name];
      if (isFiniteNumber(value)) {
        values[key] = value;
        break;
      }
    }
  }
  return { fields: Object.keys(values), values };
}

/**
 * Read runskein Usage keys off a `usage_update` payload, honouring the nested
 * `usage` object some engines use. Mirrors core's `foldUsage`: when a nested
 * `usage` key is a non-null object, read ONLY from there — the flat level is
 * never consulted, exactly as core recurses into nested and never falls back.
 *
 * This is the `usage_update` carrier only; a `prompt_response_meta` resolved
 * object must go through {@link readTokenFields} directly (no nesting
 * descent), matching core's `foldUsageReport`.
 * @param payload - the raw usage_update payload.
 * @param declared - the adapter's declared alias names, if any.
 * @returns which runskein keys resolved and their numbers.
 */
export function readUsageUpdate(
  payload: Record<string, unknown>,
  declared?: DeclaredTokenNames,
): UsageWireReading {
  const nested = payload['usage'];
  if (typeof nested === 'object' && nested !== null) {
    return readUsageUpdate(nested as Record<string, unknown>, declared);
  }
  return readTokenFields(payload, declared);
}

/**
 * Walk an object-key path into a response object (objects only — no arrays,
 * no coercion), mirroring core's prompt_response_meta resolution.
 * @param response - the raw prompt response result.
 * @param path - the adapter-declared object-key path.
 * @returns the resolved object, or undefined when nothing usable is there.
 */
export function resolveObjectPath(
  response: unknown,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let current: unknown = response;
  for (const segment of path) {
    // Objects only at every hop — arrays are never a legal intermediate,
    // matching core's resolveUsagePath rejection at each step.
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

/** The `usage` summary row UA-MTX-01 adds to the capability matrix. */
export interface UsageMatrixRow {
  /** The declared source resolved and at least one token field was numeric. */
  ok: boolean;
  /** The declared source kind, or 'none' when the adapter declares nothing. */
  source: string;
  /** RunSkein Usage keys that actually resolved on this engine. */
  fields: string[];
  /** Declared semantics, echoed so a reader knows what the numbers mean. */
  semantics: string;
}

/** Minimal shape of a usage_update notification this module reads. */
export interface UsageUpdateLike {
  update: { sessionUpdate?: string } & Record<string, unknown>;
}

/**
 * Compute the matrix `usage` row from material the probe already captured
 * (test plan §4): the declared mapping plus the accounting turn's response and
 * update stream. Spawns nothing new; engines declaring nothing get a 'none'
 * row whose fields show what the default handling picked up.
 * @param adapter - the engine adapter whose declaration is being measured.
 * @param promptResponse - the captured session/prompt response result.
 * @param updates - the update notifications of that turn.
 * @returns the row to merge into docs/conformance/matrix.json.
 */
export function computeUsageRow(
  adapter: EngineAdapter,
  promptResponse: unknown,
  updates: UsageUpdateLike[],
): UsageMatrixRow {
  const mapping = adapter.usage;
  const semantics = mapping?.semantics ?? 'cumulative';
  const usageUpdates = updates.filter((n) => n.update?.sessionUpdate === 'usage_update');

  if (mapping === undefined) {
    const fields = new Set<string>();
    for (const n of usageUpdates) {
      for (const field of readUsageUpdate(n.update).fields) fields.add(field);
    }
    return { ok: false, source: 'none', fields: [...fields].sort(), semantics };
  }

  if (mapping.source.kind === 'prompt_response_meta') {
    const report = resolveObjectPath(promptResponse, mapping.source.path);
    // The resolved object's own shape is authoritative — no nested-`usage`
    // descent, matching core's foldUsageReport (not foldUsage).
    const reading = report !== undefined ? readTokenFields(report, mapping.tokens) : { fields: [] };
    return {
      ok: reading.fields.length > 0,
      source: mapping.source.kind,
      fields: reading.fields,
      semantics,
    };
  }

  const fields = new Set<string>();
  for (const n of usageUpdates) {
    for (const field of readUsageUpdate(n.update, mapping.tokens).fields) fields.add(field);
  }
  return { ok: fields.size > 0, source: mapping.source.kind, fields: [...fields].sort(), semantics };
}
