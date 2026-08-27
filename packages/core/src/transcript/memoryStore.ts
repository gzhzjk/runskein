/**
 * memoryStore — a TranscriptStore that keeps everything in process memory.
 *
 * Persistence cannot be switched off: the store is authoritative for session
 * lists and resume, and omitting one silently means "write JSONL into the
 * current working directory". Hosts that genuinely want no durable transcript
 * — tests, embedded hosts, short-lived bridges — need a real implementation of
 * the contract rather than a footgun, so one ships here.
 *
 * Semantics, stated plainly because they are the whole point:
 * - **Unbounded.** Events accumulate for the life of the process. There is no
 *   cap and no eviction, because a store that silently dropped events would
 *   break resume exactly the way automatic retention would.
 * - **Lost on exit.** Nothing survives the process; resume works within one
 *   run only.
 * - **`sessions()` is O(total events)** — it folds every session's stream on
 *   each call. Fine for the session counts these hosts have; jsonlStore's
 *   sidecar or sqliteStore's indexes are the answer at scale.
 */
import { NotFoundError } from '../errors.js';
import {
  buildDigest,
  type DigestOptions,
  type DigestResult,
  type StructuredDigestOptions,
  type TextDigestOptions,
} from './digest.js';
import type { StructuredDigest, TranscriptDigest, TranscriptEvent } from './event.js';
import {
  foldSessionMeta,
  matchesFilter,
  type SessionFilter,
  type SessionMeta,
  type TranscriptStore,
} from './store.js';

/**
 * Create an in-memory TranscriptStore.
 *
 * Each call returns an independent store owning its own events; nothing is
 * shared between instances and nothing is written to disk.
 * @returns a TranscriptStore holding every event in memory until the process exits.
 */
export function memoryStore(): TranscriptStore {
  // Grouped by session rather than one flat log: read/digest/delete then cost
  // the session's own size instead of a scan over unrelated history.
  const bySession = new Map<string, TranscriptEvent[]>();

  /**
   * Look up a session's events, or reject when the session is unknown.
   * @param sessionId - the session to look up.
   * @param resource - which resource the NotFoundError should name.
   * @returns the session's live event array in append order.
   * @throws NotFoundError when the session has never been appended to.
   */
  const eventsFor = (sessionId: string, resource: 'transcript' | 'session'): TranscriptEvent[] => {
    const events = bySession.get(sessionId);
    if (events === undefined) {
      throw new NotFoundError({ resource, resourceId: sessionId, sessionId });
    }
    return events;
  };

  /**
   * Copy one session's events so a reader is isolated from later mutation.
   * @param sessionId - the session to snapshot.
   * @returns a stable copy of the session's events in append order.
   * @throws NotFoundError when the session has never been appended to.
   */
  const snapshot = (sessionId: string): TranscriptEvent[] =>
    // Copy so an append or delete landing mid-iteration cannot make a reader
    // skip or repeat an event; the disk-backed stores get the same isolation
    // for free from their open file handle / statement.
    eventsFor(sessionId, 'transcript').slice();

  return {
    /**
     * Retain one event in memory, keyed by its session.
     *
     * The event is held by reference, not copied: the disk-backed stores
     * serialize on the way in and so freeze a caller that keeps mutating an
     * already-appended event, while this one would show the mutation. Cloning
     * every event to hide that costs real memory on the store whose entire
     * budget is memory, and nothing in the library mutates a published event.
     * @param event - the event to store; sessionId selects the group.
     */
    async append(event: TranscriptEvent): Promise<void> {
      const events = bySession.get(event.sessionId);
      if (events === undefined) bySession.set(event.sessionId, [event]);
      else events.push(event);
    },

    /**
     * Stream a session's events in seq order, honoring inclusive seq bounds.
     * @param sessionId - the session to read.
     * @param opts - optional fromSeq/toSeq bounds.
     * @returns the matching events in order.
     * @throws NotFoundError for an unknown session.
     */
    async *read(
      sessionId: string,
      opts?: { fromSeq?: number; toSeq?: number },
    ): AsyncIterable<TranscriptEvent> {
      for (const event of snapshot(sessionId)) {
        if (opts?.fromSeq !== undefined && event.seq < opts.fromSeq) continue;
        if (opts?.toSeq !== undefined && event.seq > opts.toSeq) continue;
        yield event;
      }
    },

    /**
     * Fold every retained session into its metadata and apply the filter.
     * @param filter - optional engine/status/cwd/time filtering.
     * @returns matching sessions sorted by creation time, like the other built-ins.
     */
    async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
      const metas: SessionMeta[] = [];
      for (const events of bySession.values()) {
        const meta = foldSessionMeta(events);
        if (meta && matchesFilter(meta, filter)) metas.push(meta);
      }
      return metas.sort((a, b) => a.createdAt - b.createdAt);
    },

    digest: (() => {
      function digest(sessionId: string): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
      function digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: DigestOptions): Promise<DigestResult>;
      async function digest(sessionId: string, opts?: DigestOptions): Promise<DigestResult> {
        return buildDigest(sessionId, snapshot(sessionId), opts);
      }
      return digest;
    })(),

    /**
     * Drop a session and all of its events.
     * @param sessionId - the session to delete.
     * @throws NotFoundError when the session does not exist.
     */
    async delete(sessionId: string): Promise<void> {
      // Called for its rejection: deleting an unknown session is an error in
      // this contract, not a silent no-op.
      eventsFor(sessionId, 'session');
      bySession.delete(sessionId);
    },
  };
}
