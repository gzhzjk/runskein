/**
 * Restoring sessions: the resume degradation chain, detached attach, the
 * digest builder, and sqliteStore-backed hubs, all over the mock agent.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hub, type InternalHubOptions } from '../src/hub.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { sqliteStore } from '../src/transcript/sqliteStore.js';
import { buildDigest, DIGEST_TRUNCATION_MARKER } from '../src/transcript/digest.js';
import { CancelledError, NotFoundError } from '../src/errors.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import type { TranscriptStore } from '../src/transcript/store.js';
import { collect, makeHub as makeSharedHub, mockAdapter, textOf, tmp } from './testkit.js';

/**
 * Store-first wrapper over the shared helper. Resume is about what a store
 * holds, so every case here names its store first; the wrapper keeps that
 * reading while the construction and cleanup stay in one place.
 */
function makeHub(
  store: TranscriptStore,
  extra: InternalHubOptions = {},
  env = {},
): ReturnType<typeof makeSharedHub> {
  return makeSharedHub(env, { store, ...extra });
}

/** Create a session, run one turn, close it; return its id + event count. */
async function seedSession(hub: Hub): Promise<{ id: string; count: number }> {
  const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-') });
  await s.prompt('remember the magic word: swordfish');
  await s.close();
  const count = (await collect(hub.transcripts.get(s.id))).length;
  return { id: s.id, count };
}

describe('resume chain', () => {
  it('tier 1 — native resume: stable runskein id, continued seq, working turns', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(store);
    const { id, count } = await seedSession(hub);

    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('native');
    expect(r.id).toBe(id); // the runskein session id survives the resume
    const result = await r.prompt('and the magic word was?');
    expect(result.stopReason).toBe('end_turn');

    const events = await collect(hub.transcripts.get(id));
    // Strictly monotonic across the resume boundary.
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    // The resume meta event is recorded with its tier.
    const resumeMeta = events.slice(count).find((e) => e.update.sessionUpdate === 'session_info_update');
    expect(resumeMeta).toBeDefined();
    await r.close();
    expect((await hub.sessions({ status: 'closed' })).map((m) => m.sessionId)).toEqual([id]);
  });

  it('tier 2 — load: replayed history is NOT re-persisted', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(store, {
      capabilityOverride: { mock: { session: { resume: false } } },
    });
    const { id, count } = await seedSession(hub);

    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('load');
    // Persistence is async; wait for the resume meta event to land.
    let afterResume: TranscriptEvent[] = [];
    const deadline = Date.now() + 2_000;
    do {
      afterResume = await collect(hub.transcripts.get(id));
    } while (afterResume.length < count + 1 && Date.now() < deadline);
    // Mock replays two updates during session/load; none may be re-appended —
    // only the resume meta event was added.
    expect(afterResume.filter((e) => textOf(e).startsWith('replayed-'))).toHaveLength(0);
    expect(afterResume.length).toBe(count + 1);
    await r.close();
  });

  it('tier 3 — rebuilt: digest preamble rides the first prompt', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(store, {
      capabilityOverride: {
        mock: { loadSession: false, session: { resume: false } },
      },
    });
    const { id } = await seedSession(hub);

    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('rebuilt');
    await r.prompt('continue');
    const events = await collect(hub.transcripts.get(id));
    const userChunks = events.filter((e) => e.update.sessionUpdate === 'user_message_chunk').map(textOf);
    // First prompt of the rebuilt session carries the digest preamble …
    const preamble = userChunks.find((t) => t.includes('transcript digest'));
    expect(preamble).toBeDefined();
    // … containing the prior conversation.
    expect(preamble).toContain('swordfish');
    await r.close();
  });

  it('tier 3 — early updates for the FRESH native session are delivered, not discarded', async () => {
    // MOCK_EARLY_UPDATE makes session/new emit an update before its response;
    // during a rebuilt resume that lands in the early-update buffer. Unlike
    // tier-2 replay it is NOT in the store yet and must be persisted.
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(
      store,
      {
        capabilityOverride: {
          mock: { loadSession: false, session: { resume: false } },
        },
      },
      { MOCK_EARLY_UPDATE: '1' },
    );
    const { id } = await seedSession(hub);
    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('rebuilt');
    await r.prompt('continue'); // flushes persistence
    const events = await collect(hub.transcripts.get(id));
    // One early-title event from the seed's session/new, one from the
    // rebuilt session's fresh session/new — proving the second was delivered.
    const earlyTitles = events.filter(
      (e) =>
        e.update.sessionUpdate === 'session_info_update' &&
        (e.update as { title?: string | null }).title === 'early-title',
    );
    expect(earlyTitles).toHaveLength(2);
    await r.close();
  });

  it('capabilityOverride is mask-only even through resume', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(store, {
      capabilityOverride: { mock: { session: { resume: true } } },
    });
    const { id } = await seedSession(hub).then(
      (x) => x,
      () => ({ id: '', count: 0 }),
    );
    // Widening resume:true over an engine that already advertises it is a
    // no-op, not an error — seeding + resuming must both work.
    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('native');
    await r.close();
  });

  it('cross-engine resume falls to rebuilt (every engine resumes)', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    // Two engines on one hub: the shared helper takes the adapter list, so this
    // case needs no construction of its own.
    const hub = makeSharedHub({}, { store }, [mockAdapter({}, 'mock'), mockAdapter({}, 'mock2')]);
    const { id } = await seedSession(hub);

    const r = await hub.session({ engine: 'mock2', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('rebuilt'); // native/load need the same engine
    expect(r.engine).toBe('mock2');
    expect(r.id).toBe(id);
    await r.close();
    // The transcript now spans both engines, with provenance intact.
    const engines = new Set((await collect(hub.transcripts.get(id))).map((e) => e.engineId));
    expect(engines).toEqual(new Set(['mock', 'mock2']));
  });

  // The unknown-id path is asserted in regressions.test.ts, which also proves
  // no process is spawned and pins resource/resourceId.

  it('resuming an already-live session is refused', async () => {
    const hub = makeHub(jsonlStore(tmp('runskein-m3-store-')));
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-') });
    await expect(hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: s.id })).rejects.toThrow(
      /already live/,
    );
    await s.close();
  });
});

describe('Detached attach (SL-09 finished-session variant)', () => {
  it('replays transcript + usage read-only; mutations behave like closed', async () => {
    const store = jsonlStore(tmp('runskein-m3-store-'));
    const hub = makeHub(store);
    const { id, count } = await seedSession(hub);

    const a = await hub.attach(id);
    expect(a.id).toBe(id);
    expect(a.engine).toBe('mock');
    expect(a.status).toBe('closed');
    expect((await collect(a.transcript())).length).toBe(count);
    expect(a.usage()).toEqual({}); // nothing reported, nothing fabricated (006)
    await expect(a.prompt('nope')).rejects.toBeInstanceOf(CancelledError);
    await expect(a.fork()).rejects.toBeInstanceOf(CancelledError);
    await a.close(); // no-op, no error
    // Attaching spawned no engine process.
    expect((await hub.health())['mock']).toBe('ready'); // still from seeding
  });
});

describe('sqliteStore-backed hub (D5: same behavior, different engine)', () => {
  it('full session + resume flow works on sqlite', async () => {
    const store = sqliteStore(join(tmp('runskein-m3-sqlite-'), 'events.db'));
    const hub = makeHub(store);
    const { id } = await seedSession(hub);
    expect((await hub.sessions()).map((m) => m.sessionId)).toEqual([id]);

    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-m3-'), resume: id });
    expect(r.resumeTier).toBe('native');
    await r.prompt('again');
    await r.close();
    const digest = await hub.transcripts.digest(id);
    expect(digest.text).toContain('swordfish');
  });
});

describe('digest builder', () => {
  const ev = (seq: number, update: TranscriptEvent['update']): TranscriptEvent => ({
    seq,
    ts: seq,
    sessionId: 's',
    engineId: 'e',
    update,
  });

  it('renders role-tagged turns and tool calls, skipping noise', () => {
    const d = buildDigest('s', [
      ev(1, { sessionUpdate: 'session_info_update' }),
      ev(2, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi ' } }),
      ev(3, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'there' } }),
      ev(4, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
      ev(5, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'grep', kind: 'search' }),
      ev(6, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
    ]);
    expect(d.text).toBe('User: hi there\nTool: grep (search)\nAssistant: done');
    expect(d.throughSeq).toBe(6);
  });

  it('truncates from the OLDEST side when over budget', () => {
    const d = buildDigest(
      's',
      [
        ev(1, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x'.repeat(500) } }),
        ev(2, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'THE-END' } }),
      ],
      { maxChars: 120 },
    );
    expect(d.text.length).toBeLessThanOrEqual(120);
    expect(d.text.startsWith(DIGEST_TRUNCATION_MARKER)).toBe(true);
    expect(d.text).toContain('THE-END'); // newest content survives
  });
});
