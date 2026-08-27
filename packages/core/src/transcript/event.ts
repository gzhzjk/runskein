/**
 * The transcript envelope: runskein's `{seq, ts, sessionId, engineId}` wrapped
 * around the protocol's SessionUpdate vocabulary, verbatim. `usage` is
 * runskein-owned because the protocol's own usage type is still unstable.
 *
 * Session lifecycle metadata (cwd, status transitions) rides the transcript as
 * `session_info_update` events carrying a runskein `_meta` entry — the protocol's
 * own extension point, so there is no second event vocabulary to keep in sync.
 * This is what lets ANY TranscriptStore implementation answer `sessions()`
 * from nothing but its `append()` stream.
 */
import type { ContentBlock, SessionUpdate } from '../vocabulary.js';

export interface Usage {
  input?: number;
  output?: number;
  total?: number;
  uncached?: number;
  cacheRead?: number;
  cacheCreation?: number;
  thought?: number;
}

export interface UsageSummary extends Usage {
  cost?: number;
  currency?: string;
}

/** The token fields runskein's own Usage vocabulary owns. */
export const USAGE_TOKEN_KEYS = [
  'input',
  'output',
  'total',
  'uncached',
  'cacheRead',
  'cacheCreation',
  'thought',
] as const;

export type UsageTokenKey = (typeof USAGE_TOKEN_KEYS)[number];

/** Where an engine's usage accounting arrives on the wire. */
export type UsageSource =
  | { kind: 'usage_update' }
  /** A path of object keys into the prompt response's result, e.g. `_meta.quota.token_count`. */
  | { kind: 'prompt_response_meta'; path: string[] };

/**
 * An adapter's declaration of where its usage accounting lives and what one
 * report means. Pure data beside `errorPatterns` and `configHints` — core runs
 * one interpreter over it and never learns an engine's name. Declaring nothing
 * is exactly the pre-declaration behaviour.
 */
export interface UsageMapping {
  source: UsageSource;
  /**
   * Additional engine field names per runskein Usage key, tried before the
   * built-in alias table, first match wins. Additive only: name what core does
   * not already recognize; restating a built-in alias creates a second place
   * to keep it right.
   */
  tokens?: Partial<Record<UsageTokenKey, string[]>>;
  /**
   * Whether one report is the running session total (`cumulative`) or only the
   * turn it belongs to (`per-turn`). `per-turn` is legal only for the
   * `prompt_response_meta` source: an engine-sent `usage_update` is stored
   * verbatim and replay replaces within a segment, so per-turn numbers in that
   * carrier would resume as the last turn alone.
   */
  semantics: 'cumulative' | 'per-turn';
}

export interface TranscriptEvent {
  seq: number; // monotonic per session (runskein-assigned)
  ts: number; // epoch ms (runskein-assigned)
  sessionId: string;
  engineId: string; // provenance; the protocol carries none of these three
  update: SessionUpdate; // protocol vocabulary, verbatim
  usage?: Usage; // runskein-owned, so an unstable protocol type cannot leak here
}

export interface TranscriptDigest {
  sessionId: string;
  throughSeq: number;
  text: string;
}

/** Role of content retained in a structured digest. */
export type DigestRole = 'user' | 'assistant' | 'tool';

/** One chronological same-role run extracted from a transcript. */
export interface DigestSegment {
  role: DigestRole;
  text: string;
  fromSeq: number;
  toSeq: number;
}

/** Bounded, structured handoff representation of a transcript. */
export interface StructuredDigest {
  sessionId: string;
  throughSeq: number;
  segments: DigestSegment[];
  truncatedRanges: Array<{ fromSeq: number; toSeq: number }>;
  estimatedTokens: number;
}

// ── RunSkein session-meta events ───────────────────────────────

export const RUNSKEIN_SESSION_META_KEY = 'runskein.dev/sessionMeta';

export type SessionStatus = 'idle' | 'running' | 'awaiting-input' | 'closed' | 'failed';

/** The payload runskein rides in `session_info_update`._meta. */
export interface RunskeinSessionMeta {
  cwd?: string;
  status?: SessionStatus;
  /** Engine-side session id; without it only a digest rebuild can resume. */
  nativeSessionId?: string;
  /** Set on the meta event a resume writes: which tier restored the session. */
  resumeTier?: 'native' | 'load' | 'rebuilt';
}

/**
 * Build the envelope-able update announcing creation or a status change.
 * @param meta - cwd/status/native id/tier to persist for the session.
 * @returns a session_info_update carrying the runskein meta in its `_meta`.
 */
export function sessionMetaUpdate(meta: RunskeinSessionMeta): SessionUpdate {
  return {
    sessionUpdate: 'session_info_update',
    _meta: { [RUNSKEIN_SESSION_META_KEY]: meta },
  };
}

/**
 * Extract runskein session meta from an update, if present.
 * @param update - a session update.
 * @returns the runskein meta, or undefined when the update is not a session_info_update.
 */
export function readSessionMeta(update: SessionUpdate): RunskeinSessionMeta | undefined {
  if (update.sessionUpdate !== 'session_info_update') return undefined;
  const meta = update._meta?.[RUNSKEIN_SESSION_META_KEY];
  return typeof meta === 'object' && meta !== null ? (meta as RunskeinSessionMeta) : undefined;
}

// ── RunSkein prompt echo ───────────────────────────────────────

export const RUNSKEIN_PROMPT_ECHO_KEY = 'runskein.dev/promptEcho';

/**
 * Build the `user_message_chunk` runskein writes for a block it sent as the user
 * turn, so a transcript reads as a conversation rather than as one side of it.
 * That is what the host submitted plus, on the first turn of a rebuilt resume,
 * the recovered-context preamble runskein prepended — the prompt as the engine
 * received it, not as the caller typed it.
 *
 * The marker is what separates it from the identical-looking chunk an engine
 * may send while replaying context: both reach a subscriber on the same stream
 * (decision 035), and a host that renders its own input needs to know which one
 * it is already showing.
 * @param content - one block of the prompt as it was sent to the engine.
 * @returns a user_message_chunk carrying the marker.
 */
export function promptEchoUpdate(content: ContentBlock): SessionUpdate {
  return {
    sessionUpdate: 'user_message_chunk',
    content,
    _meta: { [RUNSKEIN_PROMPT_ECHO_KEY]: {} },
  };
}

/**
 * Recognize the `user_message_chunk` runskein echoed for a submitted prompt.
 * @param update - a session update.
 * @returns true when runskein wrote this chunk, false when it came from the engine.
 */
export function isPromptEcho(update: SessionUpdate): boolean {
  if (update.sessionUpdate !== 'user_message_chunk') return false;
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  return typeof meta === 'object' && meta !== null && RUNSKEIN_PROMPT_ECHO_KEY in meta;
}

/** Cumulative session cost, as reported by a usage_update. */
export interface CostInfo {
  cost: number;
  currency: string;
}

/** Result of combining cumulative costs without inventing FX conversion. */
export interface CombinedCost {
  cost?: CostInfo;
  mixedCurrencies: boolean;
}

/**
 * Extract the cumulative cost from a usage_update payload, if reported.
 * @param raw - the usage_update payload.
 * @returns the parsed cost, or undefined when absent or malformed.
 */
export function readCost(raw: Record<string, unknown>): CostInfo | undefined {
  const cost = raw['cost'];
  if (typeof cost !== 'object' || cost === null) return undefined;
  const { amount, currency } = cost as { amount?: unknown; currency?: unknown };
  if (typeof amount !== 'number' || typeof currency !== 'string') return undefined;
  return { cost: amount, currency };
}

/**
 * Add costs only when their currencies agree. A single UsageSummary cannot
 * represent a multi-currency total, so a conflict is carried explicitly and
 * the scalar cost stays absent.
 * @param costs - the cumulative cost reports to sum.
 * @param alreadyMixed - treat the result as multi-currency from the start.
 * @returns the combined cost, or a mixed-currencies marker when currencies clash.
 */
export function combineCosts(costs: Iterable<CostInfo | undefined>, alreadyMixed = false): CombinedCost {
  let combined: CostInfo | undefined;
  let mixedCurrencies = alreadyMixed;
  for (const item of costs) {
    if (item === undefined) continue;
    if (combined === undefined) {
      combined = { ...item };
    } else if (combined.currency === item.currency) {
      combined.cost += item.cost;
    } else {
      mixedCurrencies = true;
    }
  }
  if (mixedCurrencies) return { mixedCurrencies: true };
  return combined === undefined ? { mixedCurrencies: false } : { cost: combined, mixedCurrencies: false };
}

/**
 * RunSkein's own field name for each Usage key, as the built-in alias table reads
 * them. Synthesized transcript events are written in exactly these names so a
 * transcript stays replayable after (or without) the adapter declaration that
 * produced it.
 */
export const RUNSKEIN_TOKEN_FIELD: Record<UsageTokenKey, string> = {
  input: 'inputTokens',
  output: 'outputTokens',
  total: 'totalTokens',
  uncached: 'uncachedTokens',
  cacheRead: 'cacheReadTokens',
  cacheCreation: 'cacheCreationTokens',
  thought: 'thoughtTokens',
};

/** Built-in engine field names per Usage key; declared aliases are tried first. */
const BUILTIN_TOKEN_ALIASES: Record<UsageTokenKey, string[]> = {
  input: ['inputTokens', 'input'],
  output: ['outputTokens', 'output'],
  total: ['totalTokens', 'total'],
  uncached: ['uncachedTokens', 'uncached'],
  cacheRead: ['cacheReadTokens', 'cacheRead', 'cachedTokens'],
  cacheCreation: ['cacheCreationTokens', 'cacheCreation'],
  thought: ['thoughtTokens', 'thought'],
};

/** Every built-in alias, flattened — the "does this payload carry tokens at all" gate. */
const TOKEN_KEYS: string[] = Object.values(BUILTIN_TOKEN_ALIASES).flat();

// ── RunSkein synthetic usage events ────────────────────────────

export const RUNSKEIN_SYNTHETIC_USAGE_KEY = 'runskein.dev/syntheticUsage';

/**
 * Build the synthesized `usage_update` a `prompt_response_meta` report is
 * persisted as: runskein's own field names, carrying the session-cumulative value,
 * marked so it stays distinguishable from an engine-sent event (the envelope's
 * verbatim contract). Replay folds it through the ordinary path with no
 * adapter and no semantics knowledge.
 *
 * The protocol's `used`/`size` fields are deliberately absent — fabricating a
 * window gauge from token counts would be invention (decision 024), so the
 * cast past the generated type is load-bearing honesty, not convenience.
 * @param cumulative - the session-cumulative usage to persist.
 * @returns a usage_update update carrying the marked report.
 */
export function syntheticUsageUpdate(cumulative: Usage): SessionUpdate {
  const fields: Record<string, unknown> = {};
  for (const key of USAGE_TOKEN_KEYS) {
    const value = cumulative[key];
    if (value !== undefined) fields[RUNSKEIN_TOKEN_FIELD[key]] = value;
  }
  return {
    sessionUpdate: 'usage_update',
    ...fields,
    _meta: { [RUNSKEIN_SYNTHETIC_USAGE_KEY]: {} },
  } as unknown as SessionUpdate;
}

/**
 * Recognize a runskein-synthesized usage event.
 * @param update - a session update.
 * @returns true when the update carries the synthetic marker.
 */
export function isSyntheticUsageUpdate(update: SessionUpdate): boolean {
  if (update.sessionUpdate !== 'usage_update') return false;
  const meta = (update as { _meta?: Record<string, unknown> })._meta;
  return typeof meta === 'object' && meta !== null && RUNSKEIN_SYNTHETIC_USAGE_KEY in meta;
}

/**
 * Key-wise sum of two Usage records; absent-on-both stays absent.
 * @param a - first usage record.
 * @param b - second usage record.
 * @returns a record with each token key summed where either side reported it.
 */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  const out: Usage = {};
  for (const key of USAGE_TOKEN_KEYS) {
    const av = a?.[key];
    const bv = b?.[key];
    if (av !== undefined || bv !== undefined) out[key] = (av ?? 0) + (bv ?? 0);
  }
  return out;
}

/**
 * Per-field difference between two cumulative readings, clamped at zero so an
 * engine-side counter reset cannot turn a turn value negative.
 * @param later - the reading at turn settlement.
 * @param earlier - the snapshot taken when the turn opened.
 * @returns the clamped delta, or undefined when `later` reported nothing.
 */
export function diffUsage(later: Usage | undefined, earlier: Usage | undefined): Usage | undefined {
  if (later === undefined) return undefined;
  const out: Usage = {};
  for (const key of USAGE_TOKEN_KEYS) {
    const value = later[key];
    if (value === undefined) continue;
    out[key] = Math.max(0, value - (earlier?.[key] ?? 0));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fold a wire usage_update payload into a running runskein Usage.
 *
 * The protocol's stable usage_update carries only {used, size, cost} with no
 * token breakdown, so a payload without token fields returns `prev` UNCHANGED
 * (possibly undefined): absent stays absent rather than being fabricated as
 * zero. Engines that do report tokens put them either at the top level or
 * inside a nested `usage` object, so both are recognized — the nested descent
 * is a property of this carrier only; a resolved `_meta` report goes through
 * {@link foldUsageReport}, which reads the object it is given and never
 * second-guesses where it came from.
 *
 * @param prev - the running runskein Usage, or undefined when none was reported yet.
 * @param raw - the wire usage_update payload.
 * @param declared - adapter-declared alias names per Usage key, tried BEFORE
 *   the built-in table (first match wins). They extend, never replace, the
 *   built-ins — and they count toward the recognition gate, so a payload whose
 *   only recognizable fields are declared ones is still read as a token report.
 * @returns the folded Usage, or `prev` unchanged when the payload carries no token fields.
 */
export function foldUsage(
  prev: Usage | undefined,
  raw: Record<string, unknown>,
  declared?: Partial<Record<UsageTokenKey, readonly string[]>>,
): Usage | undefined {
  const nested = raw['usage'];
  if (typeof nested === 'object' && nested !== null) {
    return foldUsage(prev, nested as Record<string, unknown>, declared);
  }
  return foldUsageReport(prev, raw, declared);
}

/**
 * Fold one already-resolved usage report object. Unlike {@link foldUsage} this
 * never descends into a nested `usage` key: the caller walked an adapter-
 * declared path to get here, so the object's own shape is authoritative — a
 * coincidental `usage` key inside it must not hijack the read.
 * @param prev - the running runskein Usage, or undefined when nothing was reported yet.
 * @param raw - the resolved report object whose token keys are read.
 * @param declared - adapter-declared aliases consulted before the built-in table.
 * @returns the folded Usage, or `prev` unchanged when no token field is numeric.
 */
export function foldUsageReport(
  prev: Usage | undefined,
  raw: Record<string, unknown>,
  declared?: Partial<Record<UsageTokenKey, readonly string[]>>,
): Usage | undefined {
  // Numbers only, and NaN/Infinity are not measurements — a field carrying
  // them is treated as absent (never coerced, never parsed from a string).
  // Number.isFinite does not coerce, so a string "12352" fails here too.
  const numeric = (k: string): boolean => Number.isFinite(raw[k]);
  if (declared === undefined) {
    if (!TOKEN_KEYS.some(numeric)) return prev;
  } else {
    const names = [...TOKEN_KEYS, ...Object.values(declared).flat()];
    if (!names.some(numeric)) return prev;
  }
  return foldTokenFields(prev, raw, declared);
}

/**
 * Overwrite the recognized token fields from a raw payload onto a Usage.
 * @param prev - the running Usage; missing fields keep their prior value.
 * @param raw - the flat payload whose token keys are read.
 * @param declared - adapter-declared aliases consulted before the built-in table.
 * @returns the updated Usage.
 */
function foldTokenFields(
  prev: Usage | undefined,
  raw: Record<string, unknown>,
  declared?: Partial<Record<UsageTokenKey, readonly string[]>>,
): Usage {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const pick = (key: UsageTokenKey): number | undefined => {
    for (const k of [...(declared?.[key] ?? []), ...BUILTIN_TOKEN_ALIASES[key]]) {
      const v = num(raw[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const input = pick('input');
  const output = pick('output');
  const total = pick('total');
  const next: Usage = { ...prev };
  if (input !== undefined) next.input = input;
  if (output !== undefined) next.output = output;
  if (total !== undefined) next.total = total;
  else if (next.input !== undefined && next.output !== undefined) {
    next.total = next.input + next.output;
  }
  const cacheRead = pick('cacheRead');
  const cacheCreation = pick('cacheCreation');
  const thought = pick('thought');
  const uncached = pick('uncached');
  if (cacheRead !== undefined) next.cacheRead = cacheRead;
  else if (prev?.cacheRead !== undefined) next.cacheRead = prev.cacheRead;
  if (cacheCreation !== undefined) next.cacheCreation = cacheCreation;
  else if (prev?.cacheCreation !== undefined) next.cacheCreation = prev.cacheCreation;
  if (thought !== undefined) next.thought = thought;
  else if (prev?.thought !== undefined) next.thought = prev.thought;
  if (uncached !== undefined) next.uncached = uncached;
  else if (prev?.uncached !== undefined) next.uncached = prev.uncached;
  return next;
}
