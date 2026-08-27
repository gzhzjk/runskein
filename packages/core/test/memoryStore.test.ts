/**
 * memoryStore tests: the behaviour that is specific to the in-memory store and
 * therefore NOT covered by the shared store conformance suite — instance
 * independence, disk abstinence, iteration isolation from concurrent mutation,
 * and parity with jsonlStore on the two orderings the suite does not pin
 * (sessions() sort key, engine attribution across a cross-engine resume).
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/transcript/memoryStore.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { sessionMetaUpdate, type TranscriptEvent } from '../src/transcript/event.js';
import { NotFoundError } from '../src/errors.js';
import { collect } from './testkit.js';

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

describe('memoryStore', () => {
  it("instances are independent — one store never sees another's events", async () => {
    const a = memoryStore();
    const b = memoryStore();
    await a.append(ev('s1', 1, text('only in a')));
    expect((await a.sessions()).map((m) => m.sessionId)).toEqual(['s1']);
    expect(await b.sessions()).toEqual([]);
    await expect(collect(b.read('s1'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('writes nothing to disk', async () => {
    // The whole point of the store: a host that picks it must not discover
    // files appearing under its cwd anyway.
    const watched = mkdtempSync(join(tmpdir(), 'runskein-memory-store-'));
    const previous = process.cwd();
    process.chdir(watched);
    try {
      const store = memoryStore();
      await store.append(ev('s1', 1, sessionMetaUpdate({ cwd: '/w', status: 'idle' })));
      await store.append(ev('s1', 2, text('hello')));
      await store.digest('s1');
      await store.sessions();
      await store.delete('s1');
      expect(readdirSync(watched)).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  });

  it('a delete during an in-flight read cannot truncate the reader', async () => {
    // read() snapshots, so a reader that yields between events still observes
    // the transcript it started on rather than silently ending early.
    const store = memoryStore();
    for (let seq = 1; seq <= 4; seq++) await store.append(ev('s1', seq, text(`t${seq}`)));
    const seen: number[] = [];
    for await (const e of store.read('s1')) {
      seen.push(e.seq);
      if (e.seq === 2) await store.delete('s1');
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    await expect(collect(store.read('s1'))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an append during an in-flight read does not extend that read', async () => {
    const store = memoryStore();
    for (let seq = 1; seq <= 2; seq++) await store.append(ev('s1', seq, text(`t${seq}`)));
    const seen: number[] = [];
    for await (const e of store.read('s1')) {
      seen.push(e.seq);
      if (e.seq === 1) await store.append(ev('s1', 3, text('late')));
    }
    expect(seen).toEqual([1, 2]);
    expect((await collect(store.read('s1'))).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('delete removes exactly one session and rejects an unknown id', async () => {
    const store = memoryStore();
    await store.append(ev('s1', 1, text('a')));
    await store.append(ev('s2', 1, text('b')));
    await store.delete('s1');
    expect((await store.sessions()).map((m) => m.sessionId)).toEqual(['s2']);
    const err = await store.delete('s1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).resourceId).toBe('s1');
  });

  it('sessions() sorts by createdAt like jsonlStore, not by append order', async () => {
    // Sessions can be appended to out of creation order (a resumed session
    // takes a new event before a freshly created one does); both built-ins
    // list by creation time, so this store must too.
    const seed = async (store: { append: (e: TranscriptEvent) => Promise<void> }): Promise<void> => {
      await store.append(ev('late', 1, sessionMetaUpdate({ cwd: '/l', status: 'idle' }), 900));
      await store.append(ev('early', 1, sessionMetaUpdate({ cwd: '/e', status: 'idle' }), 100));
      await store.append(ev('early', 2, text('more'), 950));
    };
    const memory = memoryStore();
    const jsonl = jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-memory-parity-')));
    await seed(memory);
    await seed(jsonl);
    const ids = (await memory.sessions()).map((m) => m.sessionId);
    expect(ids).toEqual(['early', 'late']);
    expect(ids).toEqual((await jsonl.sessions()).map((m) => m.sessionId));
  });

  it('attributes a cross-engine transcript to its first engine, like jsonlStore', async () => {
    const seed = async (store: { append: (e: TranscriptEvent) => Promise<void> }): Promise<void> => {
      await store.append(ev('sx', 1, sessionMetaUpdate({ cwd: '/w', status: 'idle' }), 100, 'alpha'));
      await store.append(ev('sx', 2, text('hi'), 200, 'alpha'));
      await store.append(ev('sx', 3, sessionMetaUpdate({ status: 'closed' }), 300, 'beta'));
    };
    const memory = memoryStore();
    const jsonl = jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-memory-engine-')));
    await seed(memory);
    await seed(jsonl);
    const [meta] = await memory.sessions();
    expect(meta).toMatchObject({
      engineId: 'alpha',
      status: 'closed',
      createdAt: 100,
      updatedAt: 300,
    });
    expect(meta).toEqual((await jsonl.sessions())[0]);
  });

  it('digest matches jsonlStore for the same events', async () => {
    const seed = async (store: { append: (e: TranscriptEvent) => Promise<void> }): Promise<void> => {
      await store.append(
        ev('s1', 1, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'q' },
        }),
      );
      await store.append(ev('s1', 2, text('answer one')));
      await store.append(ev('s1', 3, text(' and two')));
    };
    const memory = memoryStore();
    const jsonl = jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-memory-digest-')));
    await seed(memory);
    await seed(jsonl);
    expect(await memory.digest('s1')).toEqual(await jsonl.digest('s1'));
  });

  it('read/digest reject an unknown session with NotFoundError', async () => {
    const store = memoryStore();
    await store.append(ev('s1', 1, text('a')));
    for (const op of [() => collect(store.read('missing')), () => store.digest('missing')]) {
      const err = await op().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).resourceId).toBe('missing');
    }
  });
});
