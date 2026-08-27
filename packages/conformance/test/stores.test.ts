/**
 * Store gate: every built-in store must pass the same TranscriptStore
 * conformance suite, and so must a third-party one.
 *
 * Two distinct guarantees live here and neither substitutes for the other:
 *
 * - **Three-way parity (ST-STORE-01):** jsonl, sqlite and the exported
 *   `memoryStore()` run the identical suite in one file, so a divergence
 *   between the shipped backends is a failing case rather than a surprise at
 *   a consumer.
 * - **Implementable from outside (TR-09):** the local store below stays a
 *   test-defined implementation on purpose. A store shipped *inside* core
 *   cannot demonstrate that the contract is satisfiable by code that has no
 *   access to core's internals, so promoting `memoryStore()` in its place
 *   would quietly trade that guarantee away instead of adding to it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDigest,
  foldSessionMeta,
  jsonlStore,
  matchesFilter,
  sqliteStore,
  type SessionFilter,
  type SessionMeta,
  type TranscriptEvent,
  type TranscriptStore,
} from '@runskein/core/internal';
// memoryStore comes from the PUBLIC entry point on purpose: AC-10.1 is about
// what consumers can import, so pulling it from '/internal' would not test it.
import { memoryStore, NotFoundError } from '@runskein/core';
import { storeSuite } from '../src/storeSuite.js';

storeSuite('jsonlStore', () => ({
  store: jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-suite-jsonl-'))),
}));

storeSuite('sqliteStore', () => ({
  store: sqliteStore(join(mkdtempSync(join(tmpdir(), 'runskein-suite-sqlite-')), 'events.db')),
}));

// ST-STORE-01: the third shipped backend runs the same suite as the two
// disk-backed ones, in the same run — the parity AC-10.1 asks for.
storeSuite('memoryStore (core export, ST-STORE-01)', () => ({ store: memoryStore() }));

/**
 * Minimal store defined in test code, deliberately independent of core's own
 * implementation: it exists to show an outside author can satisfy the contract
 * using only the public/internal surface (TR-09). Kept distinct from the
 * exported `memoryStore()` above — that one proves parity, this one proves
 * implementability, and neither covers the other.
 */
class ExternalTestStore implements TranscriptStore {
  private readonly events: TranscriptEvent[] = [];

  async append(event: TranscriptEvent): Promise<void> {
    this.events.push(event);
  }

  async *read(
    sessionId: string,
    opts?: { fromSeq?: number; toSeq?: number },
  ): AsyncIterable<TranscriptEvent> {
    const all = this.events.filter((e) => e.sessionId === sessionId);
    if (all.length === 0) {
      throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
    }
    for (const e of all) {
      if (opts?.fromSeq !== undefined && e.seq < opts.fromSeq) continue;
      if (opts?.toSeq !== undefined && e.seq > opts.toSeq) continue;
      yield e;
    }
  }

  async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    const seen = new Set<string>();
    for (const e of this.events) {
      if (seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      const meta = foldSessionMeta(this.events.filter((x) => x.sessionId === e.sessionId));
      if (meta && matchesFilter(meta, filter)) metas.push(meta);
    }
    return metas;
  }

  async digest(sessionId: string) {
    const all = this.events.filter((e) => e.sessionId === sessionId);
    if (all.length === 0) {
      throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
    }
    return buildDigest(sessionId, all);
  }

  async delete(sessionId: string): Promise<void> {
    const before = this.events.length;
    const remaining = this.events.filter((e) => e.sessionId !== sessionId);
    if (remaining.length === before) {
      throw new NotFoundError({ resource: 'session', resourceId: sessionId, sessionId });
    }
    this.events.splice(0, this.events.length, ...remaining);
  }
}

storeSuite('externalTestStore (custom, TR-09)', () => ({ store: new ExternalTestStore() }));
