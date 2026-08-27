/**
 * jsonlStore tests: append/read ordering, seq filtering, sessions() from the
 * event stream alone, digest, delete, typed error contract.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { sessionMetaUpdate, type TranscriptEvent } from '../src/transcript/event.js';
import { NotFoundError } from '../src/errors.js';
import { collect } from './testkit.js';

const dir = () => mkdtempSync(join(tmpdir(), 'runskein-store-'));

function ev(sessionId: string, seq: number, update: TranscriptEvent['update'], ts = seq): TranscriptEvent {
  return { seq, ts, sessionId, engineId: 'mock', update, ...(seq === 999 ? {} : {}) };
}

const text = (t: string): TranscriptEvent['update'] => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: t },
});

describe('jsonlStore', () => {
  it('append preserves order; read honors fromSeq/toSeq', async () => {
    const store = jsonlStore(dir());
    for (let i = 1; i <= 5; i++) await store.append(ev('s1', i, text(`t${i}`)));
    const all = await collect(store.read('s1'));
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    const mid = await collect(store.read('s1', { fromSeq: 2, toSeq: 4 }));
    expect(mid.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('sessions() folds meta events; filters apply', async () => {
    const store = jsonlStore(dir());
    await store.append(ev('s1', 1, sessionMetaUpdate({ cwd: '/w1', status: 'idle' }), 100));
    await store.append(ev('s1', 2, text('x'), 150));
    await store.append(ev('s2', 1, sessionMetaUpdate({ cwd: '/w2', status: 'idle' }), 200));
    await store.append(ev('s2', 2, sessionMetaUpdate({ status: 'closed' }), 300));
    const all = await store.sessions();
    expect(all.map((m) => m.sessionId)).toEqual(['s1', 's2']);
    expect(all[1]).toMatchObject({ cwd: '/w2', status: 'closed', createdAt: 200, updatedAt: 300 });
    expect((await store.sessions({ status: 'closed' })).map((m) => m.sessionId)).toEqual(['s2']);
    expect((await store.sessions({ cwd: '/w1' })).map((m) => m.sessionId)).toEqual(['s1']);
  });

  it('uses crash-repairable sidecars for inventory instead of scanning history', async () => {
    const root = dir();
    const store = jsonlStore(root);
    await store.append(ev('s1', 1, sessionMetaUpdate({ cwd: '/workspace' }), 100));
    const transcript = join(root, 's1.jsonl');
    const sidecar = join(root, 's1.meta.json');
    expect(existsSync(sidecar)).toBe(true);

    // Preserve byte size while making the transcript invalid. A fresh store
    // can still answer inventory from the verified sidecar in O(1) per file.
    const bytes = Buffer.byteLength(readFileSync(transcript));
    writeFileSync(transcript, 'x'.repeat(bytes));
    expect(await jsonlStore(root).sessions()).toMatchObject([
      { sessionId: 's1', cwd: '/workspace', createdAt: 100 },
    ]);
  });

  it('repairs a missing or malformed metadata sidecar from the event stream', async () => {
    const root = dir();
    const store = jsonlStore(root);
    await store.append(ev('s1', 1, sessionMetaUpdate({ cwd: '/repair' }), 100));
    writeFileSync(join(root, 's1.meta.json'), '{"meta":null}', 'utf8');
    const fresh = jsonlStore(root);
    expect(await fresh.sessions()).toMatchObject([{ sessionId: 's1', cwd: '/repair' }]);
    expect(JSON.parse(readFileSync(join(root, 's1.meta.json'), 'utf8'))).toMatchObject({
      meta: { sessionId: 's1', cwd: '/repair' },
    });
  });

  it('serializes only within each session under concurrent appends', async () => {
    const store = jsonlStore(dir());
    const writes: Promise<void>[] = [];
    for (let seq = 1; seq <= 200; seq++) {
      writes.push(store.append(ev('left', seq, text(`l${seq}`))));
      writes.push(store.append(ev('right', seq, text(`r${seq}`))));
    }
    await Promise.all(writes);
    expect((await collect(store.read('left'))).map((event) => event.seq)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    expect(await collect(store.read('right'))).toHaveLength(200);
  });

  it('digest renders role-tagged text through the last seq', async () => {
    const store = jsonlStore(dir());
    await store.append(
      ev('s1', 1, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Q' } }),
    );
    await store.append(ev('s1', 2, text('A1 ')));
    await store.append(ev('s1', 3, text('A2')));
    expect(await store.digest('s1')).toEqual({
      sessionId: 's1',
      throughSeq: 3,
      text: 'User: Q\nAssistant: A1 A2',
    });
  });

  it('delete removes the session; reads then NotFoundError', async () => {
    const store = jsonlStore(dir());
    await store.append(ev('s1', 1, text('x')));
    await store.delete('s1');
    await expect(collect(store.read('s1'))).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.delete('s1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('missing session: read/digest reject NotFoundError with resource info', async () => {
    const store = jsonlStore(dir());
    const err = await store.digest('nope').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ resource: 'transcript', resourceId: 'nope' });
  });

  it('empty store lists no sessions (no directory yet)', async () => {
    const store = jsonlStore(join(dir(), 'never-created'));
    expect(await store.sessions()).toEqual([]);
  });

  it('rejects path-escaping session ids', async () => {
    const store = jsonlStore(dir());
    await expect(collect(store.read('../evil'))).rejects.toBeInstanceOf(NotFoundError);
  });
});
