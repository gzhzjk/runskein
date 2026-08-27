/**
 * TranscriptStore conformance suite: any store implementation, built-in or
 * custom, must pass it. Asserts append/read ordering, seq-range reads,
 * sessions() folding from the append stream alone, digest determinism,
 * deletion, and the typed error contract.
 *
 * Usage (vitest):
 *   storeSuite('jsonlStore', () => ({ store: jsonlStore(mkdtempSync(...)) }));
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptStore, TranscriptEvent } from '@runskein/core/internal';
import { sessionMetaUpdate } from '@runskein/core/internal';
import { NotFoundError } from '@runskein/core';

export interface StoreFactoryResult {
  store: TranscriptStore;
  teardown?: () => void | Promise<void>;
}

export type StoreFactory = () => StoreFactoryResult | Promise<StoreFactoryResult>;

/**
 * Build a synthetic transcript event for the suite fixtures.
 * @param sessionId - the session id.
 * @param seq - the sequence number.
 * @param update - the update payload.
 * @param ts - the timestamp (defaults to seq * 100).
 * @param engineId - the engine id (default 'mock').
 * @returns a complete TranscriptEvent.
 */
function ev(
  sessionId: string,
  seq: number,
  update: TranscriptEvent['update'],
  ts = seq * 100,
  engineId = 'mock',
): TranscriptEvent {
  return { seq, ts, sessionId, engineId, update };
}

const text = (t: string): TranscriptEvent['update'] => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: t },
});

const userText = (t: string): TranscriptEvent['update'] => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text: t },
});

/**
 * Drain an async iterable into an array.
 * @param it - the iterable.
 * @returns the collected values.
 */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/**
 * Append the canonical two-session fixture every case builds on: one open
 * session with a turn, and one closed session on a different engine.
 * @param store - the store to seed.
 */
async function seed(store: TranscriptStore): Promise<void> {
  await store.append(ev('s1', 1, sessionMetaUpdate({ cwd: '/w1', status: 'idle' }), 100));
  await store.append(ev('s1', 2, userText('question '), 200));
  await store.append(ev('s1', 3, text('answer one'), 300));
  await store.append(ev('s1', 4, text(' and two'), 400));
  await store.append(ev('s2', 1, sessionMetaUpdate({ cwd: '/w2', status: 'idle' }), 500, 'other'));
  await store.append(ev('s2', 2, sessionMetaUpdate({ status: 'closed' }), 600, 'other'));
}

/**
 * Register the TranscriptStore conformance suite for a store factory.
 * @param name - the store label used in test names.
 * @param factory - produces a fresh store per test.
 */
export function storeSuite(name: string, factory: StoreFactory): void {
  describe(`TranscriptStore conformance: ${name}`, () => {
    async function fresh(): Promise<TranscriptStore> {
      const { store } = await factory();
      return store;
    }

    it('append → read round-trips events in seq order', async () => {
      const store = await fresh();
      await seed(store);
      const events = await collect(store.read('s1'));
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(events[1]!.update.sessionUpdate).toBe('user_message_chunk');
      expect(events.every((e) => e.sessionId === 's1' && e.engineId === 'mock')).toBe(true);
    });

    it('read honors fromSeq/toSeq (inclusive)', async () => {
      const store = await fresh();
      await seed(store);
      expect((await collect(store.read('s1', { fromSeq: 2 }))).map((e) => e.seq)).toEqual([2, 3, 4]);
      expect((await collect(store.read('s1', { fromSeq: 2, toSeq: 3 }))).map((e) => e.seq)).toEqual([2, 3]);
    });

    it('sessions() folds meta from the append stream alone', async () => {
      const store = await fresh();
      await seed(store);
      const metas = await store.sessions();
      expect(metas.map((m) => m.sessionId)).toEqual(['s1', 's2']);
      expect(metas[0]).toMatchObject({
        engineId: 'mock',
        cwd: '/w1',
        status: 'idle',
        createdAt: 100,
        updatedAt: 400,
      });
      expect(metas[1]).toMatchObject({ cwd: '/w2', status: 'closed', engineId: 'other' });
    });

    it('sessions(filter) applies engineId/status/cwd/time filters', async () => {
      const store = await fresh();
      await seed(store);
      expect((await store.sessions({ engineId: 'other' })).map((m) => m.sessionId)).toEqual(['s2']);
      expect((await store.sessions({ status: 'closed' })).map((m) => m.sessionId)).toEqual(['s2']);
      expect((await store.sessions({ cwd: '/w1' })).map((m) => m.sessionId)).toEqual(['s1']);
      expect((await store.sessions({ since: 450 })).map((m) => m.sessionId)).toEqual(['s2']);
      expect((await store.sessions({ until: 450 })).map((m) => m.sessionId)).toEqual(['s1']);
    });

    it('digest is deterministic and covers throughSeq', async () => {
      const a = await fresh();
      const b = await fresh();
      await seed(a);
      await seed(b);
      const da = await a.digest('s1');
      const db = await b.digest('s1');
      expect(da).toEqual(db); // same events ⇒ identical digest
      expect(da.throughSeq).toBe(4);
      expect(da.text).toContain('question');
      expect(da.text).toContain('answer one and two');
    });

    it('delete removes exactly one session', async () => {
      const store = await fresh();
      await seed(store);
      await store.delete('s1');
      await expect(collect(store.read('s1'))).rejects.toBeInstanceOf(NotFoundError);
      expect((await store.sessions()).map((m) => m.sessionId)).toEqual(['s2']);
    });

    it('typed errors: NotFoundError for missing session on read/digest/delete', async () => {
      const store = await fresh();
      await seed(store);
      for (const op of [
        () => collect(store.read('missing')),
        () => store.digest('missing'),
        () => store.delete('missing'),
      ]) {
        const err = await op().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as NotFoundError).resourceId).toBe('missing');
      }
    });

    it('sessions() on an empty store returns []', async () => {
      const store = await fresh();
      expect(await store.sessions()).toEqual([]);
    });

    it('cross-engine transcript (resume onto another engine): engineId = first event', async () => {
      const store = await fresh();
      await store.append(ev('sx', 1, sessionMetaUpdate({ cwd: '/w', status: 'idle' }), 100, 'alpha'));
      await store.append(ev('sx', 2, text('hi'), 200, 'alpha'));
      await store.append(
        ev('sx', 3, sessionMetaUpdate({ status: 'idle', resumeTier: 'rebuilt' }), 300, 'beta'),
      );
      await store.append(ev('sx', 4, text('resumed'), 400, 'beta'));
      const [meta] = await store.sessions();
      expect(meta).toMatchObject({ sessionId: 'sx', engineId: 'alpha', updatedAt: 400 });
    });
  });
}
