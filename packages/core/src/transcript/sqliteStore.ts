/**
 * sqliteStore — a TranscriptStore on node:sqlite (Node ≥ 22, no external
 * dependency). The query-optimized twin of jsonlStore: `sessions(filter)`
 * needs no directory scan, and reads are indexed.
 *
 * Same observable behavior as jsonlStore, different performance profile; both
 * built-ins are held to the same store conformance suite.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { NotFoundError, StoreError } from '../errors.js';
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

// Loaded via require: bundlers/test transforms that predate the node:sqlite
// builtin (added in Node 22.5) fail to resolve a static import of it.
const requireBuiltin = createRequire(import.meta.url);

type StoreOperation = 'append' | 'read' | 'sessions' | 'digest' | 'delete';

/**
 * Create the sqlite-backed TranscriptStore (node:sqlite).
 * @param path - database file path; the directory must already exist.
 * @returns a TranscriptStore persisting events and queryable session metadata in SQLite.
 */
export function sqliteStore(path: string): TranscriptStore {
  let db: DatabaseSync | undefined;

  // Every internal helper is told which public operation it serves, so a
  // database open or prepare failure is reported against the method the caller
  // actually invoked instead of a hardcoded one.
  const open = (operation: StoreOperation): DatabaseSync => {
    if (db) return db;
    try {
      const { DatabaseSync: Database } = requireBuiltin('node:sqlite') as {
        DatabaseSync: new (path: string) => DatabaseSync;
      };
      db = new Database(path);
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          session_id TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          ts         INTEGER NOT NULL,
          engine_id  TEXT NOT NULL,
          data       TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      `);
      return db;
    } catch (e) {
      db = undefined;
      throw new StoreError({ operation, cause: e });
    }
  };

  const rowsFor = (
    operation: StoreOperation,
    sessionId: string,
    fromSeq?: number,
    toSeq?: number,
  ): TranscriptEvent[] => {
    const d = open(operation);
    try {
      const stmt = d.prepare(
        `SELECT data FROM events WHERE session_id = ?
           AND seq >= ? AND seq <= ?
         ORDER BY seq ASC`,
      );
      const rows = stmt.all(sessionId, fromSeq ?? 0, toSeq ?? Number.MAX_SAFE_INTEGER) as {
        data: string;
      }[];
      return rows.map((r) => JSON.parse(r.data) as TranscriptEvent);
    } catch (e) {
      throw new StoreError({ operation, cause: e, sessionId });
    }
  };

  const exists = (operation: StoreOperation, sessionId: string): boolean => {
    const d = open(operation);
    try {
      const row = d.prepare('SELECT 1 AS one FROM events WHERE session_id = ? LIMIT 1').get(sessionId);
      return row !== undefined;
    } catch (e) {
      throw new StoreError({ operation, cause: e, sessionId });
    }
  };

  return {
    /**
     * Insert one event. The (session_id, seq) primary key rejects a duplicate
     * seq rather than silently overwriting history.
     * @param e - the event to persist.
     * @throws StoreError on any database failure.
     */
    async append(e: TranscriptEvent): Promise<void> {
      try {
        open('append')
          .prepare('INSERT INTO events (session_id, seq, ts, engine_id, data) VALUES (?, ?, ?, ?, ?)')
          .run(e.sessionId, e.seq, e.ts, e.engineId, JSON.stringify(e));
      } catch (cause) {
        throw new StoreError({
          operation: 'append',
          cause,
          sessionId: e.sessionId,
          engineId: e.engineId,
        });
      }
    },

    /**
     * Stream a session's events in seq order, honoring inclusive seq bounds.
     * @param sessionId - the session to read.
     * @param opts - optional fromSeq/toSeq bounds.
     * @returns the matching events in order.
     * @throws NotFoundError for an unknown session.
     * @throws StoreError on any database failure.
     */
    async *read(
      sessionId: string,
      opts?: { fromSeq?: number; toSeq?: number },
    ): AsyncIterable<TranscriptEvent> {
      if (!exists('read', sessionId)) {
        throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
      }
      yield* rowsFor('read', sessionId, opts?.fromSeq, opts?.toSeq);
    },

    /**
     * Query sessions from SQL, applying optional filters.
     * @param filter - optional engine/status/cwd/time filtering.
     * @returns matching sessions ordered by creation time.
     * @throws StoreError on any database failure.
     */
    async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
      const d = open('sessions');
      let ids: string[];
      try {
        ids = (
          d
            .prepare('SELECT session_id AS id FROM events GROUP BY session_id ORDER BY MIN(ts) ASC')
            .all() as { id: string }[]
        ).map((r) => r.id);
      } catch (e) {
        throw new StoreError({ operation: 'sessions', cause: e });
      }
      const metas: SessionMeta[] = [];
      for (const id of ids) {
        // Meta events + first/last ts are enough to fold SessionMeta; avoid
        // deserializing whole transcripts for large sessions.
        try {
          // First/last by SEQ, not MIN/MAX(ts): jsonlStore folds meta in seq
          // order, so under a non-monotonic wall clock ts-extrema would make
          // the two built-in stores disagree on updatedAt (and thus on
          // since/until filtering) over identical data.
          const bounds = d
            .prepare(
              `SELECT
                 (SELECT ts FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT 1) AS min,
                 (SELECT ts FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1) AS max`,
            )
            .get(id, id) as { min: number; max: number };
          // The session is attributed to the engine of its FIRST event, the
          // same rule foldSessionMeta uses — a cross-engine resume appends
          // rows carrying a different engine_id, and must not rewrite history.
          const first = d
            .prepare('SELECT engine_id AS engine FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT 1')
            .get(id) as { engine: string };
          const metaRows = (
            d
              .prepare(
                `SELECT data FROM events WHERE session_id = ?
                   AND json_extract(data, '$.update.sessionUpdate') = 'session_info_update'
                 ORDER BY seq ASC`,
              )
              .all(id) as { data: string }[]
          ).map((r) => JSON.parse(r.data) as TranscriptEvent);
          const folded = foldSessionMeta(metaRows);
          const meta: SessionMeta = {
            sessionId: id,
            engineId: first.engine,
            cwd: folded?.cwd ?? '',
            status: folded?.status ?? 'idle',
            createdAt: bounds.min,
            updatedAt: bounds.max,
          };
          if (matchesFilter(meta, filter)) metas.push(meta);
        } catch (e) {
          if (e instanceof StoreError) throw e;
          throw new StoreError({ operation: 'sessions', cause: e, sessionId: id });
        }
      }
      return metas;
    },

    digest: (() => {
      function digest(sessionId: string): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
      function digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: DigestOptions): Promise<DigestResult>;
      async function digest(sessionId: string, opts?: DigestOptions): Promise<DigestResult> {
        if (!exists('digest', sessionId)) {
          throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
        }
        return buildDigest(sessionId, rowsFor('digest', sessionId), opts);
      }
      return digest;
    })(),

    /**
     * Delete a session's events and metadata rows.
     * @param sessionId - the session to delete.
     * @throws NotFoundError when the session does not exist; StoreError on database failure.
     */
    async delete(sessionId: string): Promise<void> {
      try {
        const res = open('delete').prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
        if (res.changes === 0) {
          throw new NotFoundError({ resource: 'session', resourceId: sessionId, sessionId });
        }
      } catch (e) {
        if (e instanceof NotFoundError) throw e;
        throw new StoreError({ operation: 'delete', cause: e, sessionId });
      }
    },
  };
}
