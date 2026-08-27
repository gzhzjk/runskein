/**
 * TranscriptStore — the pluggable persistence contract plus the
 * meta-folding helper every store can use to answer `sessions()` from its
 * append stream alone.
 */
import type { StructuredDigest, SessionStatus, TranscriptDigest, TranscriptEvent } from './event.js';
import type { DigestOptions, DigestResult, StructuredDigestOptions, TextDigestOptions } from './digest.js';
import { readSessionMeta } from './event.js';

export interface SessionFilter {
  engineId?: string;
  status?: SessionStatus;
  cwd?: string;
  since?: number; // epoch ms, inclusive
  until?: number; // epoch ms, inclusive
}

export interface SessionMeta {
  sessionId: string;
  engineId: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Persistence contract for transcripts. Implementations may fail with any
 * error; the library normalizes them into StoreError at its API boundaries.
 *
 * A store directory/database is owned by ONE process at a time. The built-in
 * stores serialize appends per session in memory only; two processes sharing
 * a store directory can corrupt each other's writes (jsonlStore's sidecar
 * rollback truncates by its own byte-offset view). Give each host its own
 * store path.
 */
export interface TranscriptStore {
  /**
   * Persist one event. Callers append in seq order per session.
   * @param e - the enveloped event.
   */
  append(e: TranscriptEvent): Promise<void>;
  /**
   * Stream one session's events in seq order.
   * @param sessionId - the session to read.
   * @param opts - inclusive seq bounds.
   * @returns the matching events; must signal NotFoundError for an unknown id.
   */
  read(sessionId: string, opts?: { fromSeq?: number; toSeq?: number }): AsyncIterable<TranscriptEvent>;
  /**
   * List every stored session, foldable from the append stream alone.
   * @param filter - optional engine/status/cwd/time filtering.
   * @returns the matching session metadata.
   */
  sessions(filter?: SessionFilter): Promise<SessionMeta[]>;
  /**
   * Build the backward-compatible text digest used for resume.
   * @param sessionId - transcript to digest.
   * @returns deterministic text/tail digest.
   */
  digest(sessionId: string): Promise<TranscriptDigest>;
  /**
   * Build structured handoff segments.
   * @param sessionId - transcript to digest.
   * @param opts - structured format and optional bounds.
   * @returns chronological structured digest.
   */
  digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
  /**
   * Build text output with explicit bounding or truncation settings.
   * @param sessionId - transcript to digest.
   * @param opts - text format and optional bounds.
   * @returns deterministic text digest.
   */
  digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
  /**
   * Build text or structured output when the format is only known dynamically.
   * @param sessionId - transcript to digest.
   * @param opts - dynamic digest format and bounds.
   * @returns the representation selected by opts.format.
   */
  digest(sessionId: string, opts: DigestOptions): Promise<DigestResult>;
  /**
   * Remove a session and its events.
   * @param sessionId - the session to delete.
   * @returns resolves once removed; must signal NotFoundError for an unknown id.
   */
  delete(sessionId: string): Promise<void>;
}

// ── Shared folding helpers (used by built-in stores; exported for custom) ──

/**
 * Fold one session's events (seq order) into its SessionMeta.
 * @param events - the session's events in seq order.
 * @returns the folded SessionMeta, or undefined for an empty stream.
 */
export function foldSessionMeta(events: Iterable<TranscriptEvent>): SessionMeta | undefined {
  let meta: SessionMeta | undefined;
  for (const e of events) {
    meta = updateSessionMeta(meta, e);
  }
  return meta;
}

/**
 * Incrementally fold one event into session metadata.
 * @param current - the accumulated meta so far, or undefined to start a new one.
 * @param event - the next event; its ts becomes updatedAt, and runskein meta (cwd/status) is applied.
 * @returns the updated SessionMeta.
 */
export function updateSessionMeta(current: SessionMeta | undefined, event: TranscriptEvent): SessionMeta {
  const meta = current ?? {
    sessionId: event.sessionId,
    engineId: event.engineId,
    cwd: '',
    status: 'idle' as const,
    createdAt: event.ts,
    updatedAt: event.ts,
  };
  const next = { ...meta, updatedAt: event.ts };
  const runskein = readSessionMeta(event.update);
  if (runskein?.cwd !== undefined) next.cwd = runskein.cwd;
  if (runskein?.status !== undefined) next.status = runskein.status;
  return next;
}

/**
 * Apply a SessionFilter to a folded SessionMeta.
 * @param meta - the session metadata to test.
 * @param filter - the filter, or undefined to accept everything.
 * @returns true when the session passes every filter field.
 */
export function matchesFilter(meta: SessionMeta, filter: SessionFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.engineId !== undefined && meta.engineId !== filter.engineId) return false;
  if (filter.status !== undefined && meta.status !== filter.status) return false;
  if (filter.cwd !== undefined && meta.cwd !== filter.cwd) return false;
  if (filter.since !== undefined && meta.updatedAt < filter.since) return false;
  if (filter.until !== undefined && meta.createdAt > filter.until) return false;
  return true;
}
