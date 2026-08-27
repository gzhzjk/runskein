/**
 * Resume — the emulated 3-tier degradation chain:
 *
 *   1. native   session/resume       (engine capability)
 *   2. load     session/load        (history replay; replayed updates are
 *                                    NOT re-persisted — the session is not
 *                                    yet registered in the hub router, so
 *                                    they drop by construction)
 *   3. rebuilt  store.digest(id) →  injected as opening context of a fresh
 *                                    session — every engine resumes,
 *                                    including cross-engine moves
 *
 * The runskein sessionId is stable across all tiers; `session.resumeTier` is
 * the only observable difference.
 *
 * Split in two on purpose: `loadResumeSource` touches ONLY the local store, so
 * hub.session({resume}) can validate the id and reject an unknown one BEFORE
 * paying for an engine spawn; `resolveResume` then runs the wire tiers against
 * an already-acquired connection.
 */
import type { AcpConnection, AcpNewSessionResult } from '../acp/connection.js';
import { NotFoundError, storeBoundaryError } from '../errors.js';
import type { CostInfo, Usage } from '../transcript/event.js';
import { addUsage, combineCosts, foldUsage, readCost, readSessionMeta } from '../transcript/event.js';
import type { TranscriptDigest, TranscriptEvent } from '../transcript/event.js';
import { foldSessionMeta } from '../transcript/store.js';
import type { SessionMeta, TranscriptStore } from '../transcript/store.js';
import type { CapabilityMatrix } from '../types.js';
import type { SessionCreationState } from './configState.js';
import type { ResumeTier } from './session.js';

/** Everything the stored transcript says about the session being resumed. */
export interface ResumeSource {
  meta: SessionMeta;
  initialSeq: number;
  /** Engine-side id of the prior life, when recorded. */
  priorNativeId?: string;
  /** Cumulative accounting recovered from the stored usage_update events. */
  accounting: RecoveredAccounting;
}

/**
 * Recovered accounting, split the way resume needs it: `baseline*` covers the
 * engine-session lives that a rebuild closed, which can only ever be added to;
 * `current*` is the still-open last segment, whose engine keeps reporting
 * cumulative values that legitimately REPLACE it when we continue it.
 */
export interface RecoveredAccounting {
  baselineUsage?: Usage;
  baselineCost?: CostInfo;
  /** Prior rebuilt lives used incompatible currencies. */
  mixedCostCurrencies?: boolean;
  currentUsage?: Usage;
  currentCost?: CostInfo;
}

/**
 * Recover cumulative accounting from a stored event stream.
 *
 * Engines report session-cumulative values, and every rebuilt resume starts a
 * fresh engine session whose counters restart at zero — so the stream is cut
 * into segments at each rebuilt-resume meta event. Within a segment a later
 * report replaces the earlier one; across segments the totals add. The last,
 * still-open segment is kept separate so continuing it can preserve replace
 * semantics without clobbering the closed lives. Fields no engine ever
 * reported stay absent rather than defaulting to zero.
 * @param events - the session's persisted events in seq order.
 * @returns the recovered baseline and current usage/cost, plus the
 * mixed-currency flag.
 */
export function recoverAccounting(events: Iterable<TranscriptEvent>): RecoveredAccounting {
  let baselineUsage: Usage | undefined;
  let baselineCost: CostInfo | undefined;
  let mixedCostCurrencies = false;
  let observedCurrency: string | undefined;
  let segmentUsage: Usage | undefined;
  let segmentCost: CostInfo | undefined;

  const closeSegment = (): void => {
    if (segmentUsage !== undefined) {
      baselineUsage = addUsage(baselineUsage, segmentUsage);
      segmentUsage = undefined;
    }
    if (segmentCost !== undefined) {
      const combined = combineCosts([baselineCost, segmentCost], mixedCostCurrencies);
      baselineCost = combined.cost;
      mixedCostCurrencies = combined.mixedCurrencies;
      segmentCost = undefined;
    }
  };

  for (const e of events) {
    if (readSessionMeta(e.update)?.resumeTier === 'rebuilt') {
      closeSegment(); // a fresh engine session begins: counters restart
      continue;
    }
    if (e.update.sessionUpdate !== 'usage_update') continue;
    const raw = e.update as unknown as Record<string, unknown>;
    // Replay deliberately runs on the built-in alias table only — a transcript
    // must outlive the adapter declaration that produced it (decision 033).
    // This is why _meta-sourced reports are persisted in runskein key names: an
    // engine-sent update whose fields only a declared alias could read would
    // replay as absent, which is the verbatim contract's accepted price.
    segmentUsage = foldUsage(segmentUsage, raw) ?? segmentUsage;
    const cost = readCost(raw);
    if (cost !== undefined) {
      if (observedCurrency !== undefined && observedCurrency !== cost.currency) {
        mixedCostCurrencies = true;
      }
      observedCurrency ??= cost.currency;
      segmentCost = cost;
    }
  }

  const out: RecoveredAccounting = {};
  if (baselineUsage !== undefined && Object.keys(baselineUsage).length > 0) {
    out.baselineUsage = baselineUsage;
  }
  if (baselineCost !== undefined) out.baselineCost = baselineCost;
  if (mixedCostCurrencies) out.mixedCostCurrencies = true;
  if (segmentUsage !== undefined) out.currentUsage = segmentUsage;
  if (segmentCost !== undefined) out.currentCost = segmentCost;
  return out;
}

/**
 * Load everything the local store knows about a session being resumed. Must
 * run before the engine is acquired, so an unknown id costs no spawn.
 * @param store - the transcript store.
 * @param resumeId - the runskein session id to restore.
 * @param engineId - the engine being resumed onto, for error provenance.
 * @returns the session meta, starting seq, prior native id, and recovered
 * accounting.
 * @throws NotFoundError when the session does not exist.
 * @throws StoreError when the store backend fails.
 */
export async function loadResumeSource(
  store: TranscriptStore,
  resumeId: string,
  engineId: string,
): Promise<ResumeSource> {
  const events: TranscriptEvent[] = [];
  try {
    for await (const e of store.read(resumeId)) events.push(e);
  } catch (e) {
    if (e instanceof NotFoundError) {
      // The store reports a missing *transcript*; from the resume API's view
      // the missing resource is the session itself.
      throw new NotFoundError({ resource: 'session', resourceId: resumeId, engineId });
    }
    throw storeBoundaryError('read', e, { engineId, sessionId: resumeId });
  }
  if (events.length === 0) {
    throw new NotFoundError({ resource: 'session', resourceId: resumeId, engineId });
  }
  const meta = foldSessionMeta(events)!;
  const priorNativeId = [...events]
    .reverse()
    .map((e) => readSessionMeta(e.update)?.nativeSessionId)
    .find((id) => id !== undefined);
  const source: ResumeSource = {
    meta,
    initialSeq: events.reduce((m, e) => Math.max(m, e.seq), 0),
    accounting: recoverAccounting(events),
  };
  if (priorNativeId !== undefined) source.priorNativeId = priorNativeId;
  return source;
}

export interface ResumeContext {
  engineId: string;
  resumeId: string;
  cwd: string;
  mcpServers?: unknown[];
  /** Forwarded to the fresh session/new that a rebuild creates. */
  /**
   * `_meta` for a session this tier has to create.
   *
   * Carries everything that only reaches an engine at creation —
   * systemInstructions, and any config an adapter declared as creation-time.
   * A rebuild makes a NEW engine session, so anything the original was created
   * with is lost unless it rides along; and unlike ordinary config, none of it
   * can be re-applied afterwards by a write.
   */
  creationMeta?: Record<string, unknown>;
  connection: AcpConnection;
  /** Ceiling shared by every wire request in the resume chain. */
  requestTimeoutMs: number;
  /**
   * Hub-owned creation race that retains the original request for late cleanup.
   * The rebuild tier must not call AcpConnection.newSession directly because a
   * connection timeout discards the late response and can leak that session.
   */
  newSession: (params: Parameters<AcpConnection['newSession']>[0]) => Promise<AcpNewSessionResult>;
  /** Masked matrix (capabilityOverride applied); decides the reachable tiers. */
  capabilities: CapabilityMatrix;
  store: TranscriptStore;
  /** Pre-loaded by loadResumeSource() before the engine was acquired. */
  source: ResumeSource;
}

export interface ResumeOutcome {
  tier: ResumeTier;
  /** Engine-side session id the resumed Session talks to. */
  nativeSessionId: string;
  /** Last stored seq; the resumed session's envelopes continue after it. */
  initialSeq: number;
  /** Rebuilt tier only: digest text to inject ahead of the first prompt. */
  preamble?: string;
  /** Additive totals of the engine sessions already closed. */
  baselineUsage?: Usage;
  baselineCost?: CostInfo;
  /** Cost is deliberately absent: prior lives used incompatible currencies. */
  mixedCostCurrencies?: boolean;
  /** Live-counter seed; set only when an engine session is being continued. */
  initialUsage?: Usage;
  initialCost?: CostInfo;
  /**
   * Raw engine result of the call that produced the session, for seeding
   * observed config state. Each tier reports under its own wire method, so a
   * host can tell restored state from freshly created state.
   */
  creationState?: SessionCreationState;
}

const PREAMBLE_HEADER =
  'Context recovered from a previous session (transcript digest follows). ' +
  'Treat it as prior conversation history and continue seamlessly.\n\n';

/**
 * Resume a session by walking the native → load → rebuilt chain, degrading to
 * the next tier whenever the engine refuses the current one.
 * @param ctx - the resume context: engine, connection, capabilities, store, cwd.
 * @returns the tier that succeeded, the engine-side session id to talk to, the
 * seq to continue from, any preamble, and the recovered accounting.
 * @throws StoreError when the digest needed by the last tier cannot be built.
 * @throws the connection's failure when even a fresh session/new is refused.
 */
export async function resolveResume(ctx: ResumeContext): Promise<ResumeOutcome> {
  const { source } = ctx;
  const sameEngine = source.meta.engineId === ctx.engineId;
  const priorNativeId = source.priorNativeId;

  const acct = source.accounting;
  const base = (tier: ResumeTier, nativeSessionId: string): ResumeOutcome => {
    const out: ResumeOutcome = { tier, nativeSessionId, initialSeq: source.initialSeq };
    if (tier === 'rebuilt') {
      // A fresh engine session, so every prior segment becomes baseline.
      const usage = addUsage(acct.baselineUsage, acct.currentUsage);
      if (Object.keys(usage).length > 0) out.baselineUsage = usage;
      const combinedCost = combineCosts(
        [acct.baselineCost, acct.currentCost],
        acct.mixedCostCurrencies === true,
      );
      if (combinedCost.cost !== undefined) out.baselineCost = combinedCost.cost;
      if (combinedCost.mixedCurrencies) out.mixedCostCurrencies = true;
    } else {
      // Continuing the last engine session: closed lives are baseline, and the
      // still-open segment seeds the live counter that later reports replace.
      if (acct.baselineUsage !== undefined) out.baselineUsage = acct.baselineUsage;
      if (acct.baselineCost !== undefined) out.baselineCost = acct.baselineCost;
      if (acct.mixedCostCurrencies === true) out.mixedCostCurrencies = true;
      if (acct.currentUsage !== undefined) out.initialUsage = acct.currentUsage;
      if (acct.currentCost !== undefined) out.initialCost = acct.currentCost;
    }
    return out;
  };

  // Native continuation. Only meaningful on the same engine with a known
  // engine-side id; a wire failure degrades to the next tier, never aborts.
  // The session already exists engine-side, so systemInstructions — a
  // creation-time input — cannot apply here.
  if (sameEngine && priorNativeId && ctx.capabilities.session['resume']) {
    try {
      const resumed = await ctx.connection.resumeSession(
        {
          sessionId: priorNativeId,
          cwd: ctx.cwd,
          ...(ctx.mcpServers ? { mcpServers: ctx.mcpServers } : {}),
        },
        { timeoutMs: ctx.requestTimeoutMs },
      );
      const out = base('native', priorNativeId);
      out.creationState = { state: resumed, source: 'session/resume' };
      return out;
    } catch {
      // engine refused (session evicted, method drift) → next tier
    }
  }

  // History replay. The hub registers the session in its update router only
  // after this resolves, so the replayed updates are dropped rather than
  // re-persisted — the local store already holds every one of them.
  if (sameEngine && priorNativeId && ctx.capabilities.loadSession) {
    try {
      const loaded = await ctx.connection.loadSession(
        {
          sessionId: priorNativeId,
          cwd: ctx.cwd,
          mcpServers: ctx.mcpServers ?? [],
        },
        { timeoutMs: ctx.requestTimeoutMs },
      );
      const out = base('load', priorNativeId);
      out.creationState = { state: loaded, source: 'session/load' };
      return out;
    } catch {
      // → next tier
    }
  }

  // Last resort: rebuild from the transcript digest onto a fresh engine
  // session. This one CREATES a session, so creation-time inputs must ride
  // along rather than be silently dropped. There is no further tier, so
  // failures here propagate.
  let digest: TranscriptDigest;
  try {
    digest = await ctx.store.digest(ctx.resumeId);
  } catch (e) {
    throw storeBoundaryError('digest', e, {
      engineId: ctx.engineId,
      sessionId: ctx.resumeId,
    });
  }
  const fresh = await ctx.newSession({
    cwd: ctx.cwd,
    // Always sent, never conditional: the ACP schema makes mcpServers required
    // on session/new, and a strict engine answers -32602 without it. This tier
    // is the one that promises every engine resumes, so it cannot be the one
    // that ships a request some engines refuse. Measured on codex 0.148.0 and
    // claude-code 2.1.238, where it broke resume after a mid-turn crash.
    mcpServers: ctx.mcpServers ?? [],
    ...(ctx.creationMeta !== undefined ? { _meta: ctx.creationMeta } : {}),
  });
  const out = base('rebuilt', fresh.sessionId);
  out.preamble = PREAMBLE_HEADER + digest.text;
  out.creationState = { state: fresh, source: 'session/new' };
  return out;
}
