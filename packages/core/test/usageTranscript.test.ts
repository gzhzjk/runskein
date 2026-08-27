/**
 * Adapter-declared usage accounting (decision 033): source exclusivity and
 * transcript/resume behaviour. Declaration, resolution and semantics cases live
 * in usageMapping.test.ts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CancelledError } from '../src/errors.js';
import { recoverAccounting } from '../src/session/resume.js';
import {
  RUNSKEIN_SYNTHETIC_USAGE_KEY,
  addUsage,
  isPromptEcho,
  isSyntheticUsageUpdate,
  readSessionMeta,
} from '../src/transcript/event.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import { collect, declared, json, makeHub, mockAdapter, PER_TURN_META, tmp } from './testkit.js';

/** Synthetic-event updates of a transcript, in seq order. */
const syntheticEvents = (events: TranscriptEvent[]): TranscriptEvent[] =>
  events.filter((e) => isSyntheticUsageUpdate(e.update));

describe('source exclusivity (UA-SRC)', () => {
  it('UA-SRC-01: with prompt_response_meta declared, a token-bearing usage_update is not counted', async () => {
    // The engine reports through BOTH carriers in the same turn; only the
    // declared one may land in accounting.
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_USAGE_PLAN: json([[{ inputTokens: 999 }]]),
          MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }]),
        },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasrc-') });
    const r = await s.prompt('one');
    expect(r.usage).toEqual({ input: 100 });
    expect(s.usage()).toEqual({ input: 100 }); // not 1099
    // The engine-sent notification is still on the transcript, verbatim…
    const events = await collect(s.transcript());
    const engineSent = events.filter(
      (e) => e.update.sessionUpdate === 'usage_update' && !isSyntheticUsageUpdate(e.update),
    );
    expect(engineSent).toHaveLength(1);
    expect(engineSent[0]!.update).toMatchObject({ inputTokens: 999 });
    await s.close();
  });

  it('UA-SRC-02: exclusivity is token-scoped — cost from usage_update still counts beside _meta tokens', async () => {
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_USAGE_PLAN: json([[{ cost: { amount: 0.25, currency: 'USD' } }]]),
          MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }]),
        },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasrc-') });
    await s.prompt('one');
    expect(s.usage()).toEqual({ input: 100, cost: 0.25, currency: 'USD' });
    await s.close();
  });

  it('UA-SRC-03: mixed-currency costs stay publicly absent and stay retained across a resume', async () => {
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_USAGE_PLAN: json([
            [{ cost: { amount: 1, currency: 'USD' } }],
            [{ cost: { amount: 2, currency: 'EUR' } }],
            [{ cost: { amount: 3, currency: 'USD' } }],
          ]),
          MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }, { inputTokens: 200 }, { inputTokens: 300 }]),
        },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasrc-') });
    await s.prompt('one'); // tokens + USD
    await s.prompt('two'); // tokens + EUR — conflict
    // Decision 007 stated as it states it: NO public conflict field, both
    // `cost` and `currency` simply absent; tokens unaffected.
    expect(s.usage()).toEqual({ input: 300 });

    await s.close();
    const r = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasrc-'), resume: s.id });
    expect(r.resumeTier).toBe('native');
    // The conflict survived the resume…
    expect(r.usage()).toEqual({ input: 300 });
    // …so a later single-currency report cannot make it disappear.
    await r.prompt('three'); // tokens + USD again
    expect(r.usage()).toEqual({ input: 600 });
    expect(r.usage().cost).toBeUndefined();
    expect(r.usage().currency).toBeUndefined();
    await r.close();
  });
});

describe('transcript and resume (UA-TX)', () => {
  it('UA-TX-01: synthesis is scoped — one marked event per _meta turn, after every engine-sent update; engine-sent events stay verbatim and alone', async () => {
    // Half one: a _meta turn writes exactly one synthesized usage_update. The
    // agent ALSO streams a token-bearing usage_update during the same turn
    // (stored verbatim though not folded — exclusivity), so the ordering
    // invariant has something real to be tested against: the synthesized event
    // must come AFTER it.
    const metaHub = makeHub({}, {}, [
      declared(
        {
          MOCK_USAGE_PLAN: json([[{ inputTokens: 999 }]]),
          MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }]),
        },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const m = await metaHub.session({ engine: 'meta', cwd: tmp('runskein-uatx-') });
    await m.prompt('one');
    const metaEvents = await collect(m.transcript());
    const synth = syntheticEvents(metaEvents);
    expect(synth).toHaveLength(1);
    const engineSent = metaEvents.filter(
      (e) => e.update.sessionUpdate === 'usage_update' && !isSyntheticUsageUpdate(e.update),
    );
    expect(engineSent).toHaveLength(1);
    expect(engineSent[0]!.update).toMatchObject({ inputTokens: 999 }); // verbatim, unfolded
    expect(synth[0]!.seq).toBeGreaterThan(engineSent[0]!.seq);
    const chunks = metaEvents.filter((e) => e.update.sessionUpdate === 'agent_message_chunk');
    expect(synth[0]!.seq).toBeGreaterThan(Math.max(...chunks.map((e) => e.seq)));
    // Envelope parity (decision 033): the synthesized event is stamped with
    // the same combined cumulative view an engine-sent usage_update gets.
    expect(synth[0]!.usage).toEqual({ input: 100 });
    expect(synth[0]!.usage).toEqual(m.usage());
    await m.close();

    // Half two: on a default adapter, the engine-sent usage_update is stored
    // verbatim with its own field names and NO synthesized event beside it.
    const defHub = makeHub({ MOCK_USAGE_PLAN: json([[{ inputTokens: 100, outputTokens: 5 }]]) });
    const d = await defHub.session({ engine: 'mock', cwd: tmp('runskein-uatx-') });
    await d.prompt('one');
    const defEvents = await collect(d.transcript());
    const usageEvents = defEvents.filter((e) => e.update.sessionUpdate === 'usage_update');
    expect(usageEvents).toHaveLength(1);
    expect(isSyntheticUsageUpdate(usageEvents[0]!.update)).toBe(false);
    expect(usageEvents[0]!.update).toMatchObject({ inputTokens: 100, outputTokens: 5 });
    // The parity anchor: engine-sent events carry their combined view in the
    // envelope too — the synthesized stamp is nothing new.
    expect(usageEvents[0]!.usage).toEqual({ input: 100, output: 5, total: 105 });
    await d.close();
  });

  it('UA-TX-02: synthesized events carry the session-cumulative value, which is what makes resume recover 600', async () => {
    const hub = makeHub({}, {}, [
      declared(
        { MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }, { inputTokens: 200 }, { inputTokens: 300 }]) },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uatx-') });
    await s.prompt('one');
    await s.prompt('two');
    await s.prompt('three');
    const before = s.usage();
    expect(before.input).toBe(600);

    const events = await collect(s.transcript());
    // Cumulative, NOT turn deltas (100/300/600, not 100/200/300).
    const carried = syntheticEvents(events).map(
      (e) => (e.update as Record<string, unknown>)['inputTokens'],
    );
    expect(carried).toEqual([100, 300, 600]);

    // The oracle is resume: replay replaces within a segment, so turn-delta
    // events would recover 300 instead of 600.
    const acct = recoverAccounting(events);
    expect(addUsage(acct.baselineUsage, acct.currentUsage)).toEqual({ input: 600 });
    await s.close();
  });

  it('UA-TX-03: synthesized payloads use runskein key names — replay works with no adapter loaded', async () => {
    // Engine names go IN (cached/reasoning), runskein names come OUT.
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_PROMPT_META_PLAN: json([
            {
              quota: {
                token_count: {
                  totalTokens: 19269,
                  inputTokens: 12352,
                  cachedInputTokens: 6912,
                  outputTokens: 5,
                  reasoningOutputTokens: 0,
                },
              },
            },
          ]),
        },
        'codex-like',
        {
          source: { kind: 'prompt_response_meta', path: ['_meta', 'quota', 'token_count'] },
          tokens: { cacheRead: ['cachedInputTokens'], thought: ['reasoningOutputTokens'] },
          semantics: 'per-turn',
        },
      ),
    ]);
    const s = await hub.session({ engine: 'codex-like', cwd: tmp('runskein-uatx-') });
    await s.prompt('one');
    const expected = s.usage();

    const events = await collect(s.transcript());
    const synth = syntheticEvents(events)[0]!.update;
    for (const runskeinField of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'thoughtTokens',
    ]) {
      expect(synth, runskeinField).toHaveProperty(runskeinField);
    }
    expect(synth).not.toHaveProperty('cachedInputTokens');
    expect(synth).not.toHaveProperty('reasoningOutputTokens');

    // Replay runs on the built-in alias table only: same numbers, no adapter.
    const recovered = recoverAccounting(events);
    expect(recovered.currentUsage).toEqual({
      input: 12352,
      output: 5,
      total: 19269,
      cacheRead: 6912,
      thought: 0,
    });
    expect(expected).toEqual({
      input: 12352,
      output: 5,
      total: 19269,
      cacheRead: 6912,
      thought: 0,
    });
    await s.close();
  });

  it('UA-TX-04: synthesized events carry the runskein marker; engine-sent ones carry none', async () => {
    const metaHub = makeHub({}, {}, [
      declared({ MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }]) }, 'meta', PER_TURN_META),
    ]);
    const m = await metaHub.session({ engine: 'meta', cwd: tmp('runskein-uatx-') });
    await m.prompt('one');
    const synth = syntheticEvents(await collect(m.transcript()))[0]!;
    expect(
      ((synth.update as { _meta?: Record<string, unknown> })._meta ?? {})[RUNSKEIN_SYNTHETIC_USAGE_KEY],
    ).toBeDefined();
    await m.close();

    const defHub = makeHub({ MOCK_USAGE_PLAN: json([[{ inputTokens: 100 }]]) });
    const d = await defHub.session({ engine: 'mock', cwd: tmp('runskein-uatx-') });
    await d.prompt('one');
    const engineSent = (await collect(d.transcript())).find(
      (e) => e.update.sessionUpdate === 'usage_update',
    )!;
    expect(isSyntheticUsageUpdate(engineSent.update)).toBe(false);
    expect((engineSent.update as { _meta?: unknown })._meta).toBeUndefined();
    await d.close();
  });

  it('UA-TX-05: resume continues accounting identically on both sources and both resume shapes', async () => {
    for (const source of ['meta', 'default'] as const) {
      for (const tier of ['native', 'rebuilt'] as const) {
        // Same effective numbers on both sources. On the rebuilt shape the
        // fourth turn belongs to a FRESH engine session, whose cumulative
        // counter restarts — so the default script restarts with it.
        const env =
          source === 'meta'
            ? {
                MOCK_PROMPT_META_PLAN: json([
                  { inputTokens: 100 },
                  { inputTokens: 200 },
                  { inputTokens: 300 },
                  { inputTokens: 400 },
                ]),
              }
            : {
                MOCK_USAGE_PLAN: json(
                  tier === 'native'
                    ? [
                        [{ inputTokens: 100 }],
                        [{ inputTokens: 300 }],
                        [{ inputTokens: 600 }],
                        [{ inputTokens: 1000 }],
                      ]
                    : [
                        [{ inputTokens: 100 }],
                        [{ inputTokens: 300 }],
                        [{ inputTokens: 600 }],
                        [{ inputTokens: 400 }],
                      ],
                ),
              };
        const adapters = source === 'meta' ? [declared(env, 'meta', PER_TURN_META)] : [mockAdapter(env)];
        const hub = makeHub(
          {},
          {
            ...(tier === 'rebuilt'
              ? {
                  capabilityOverride: {
                    [adapters[0]!.id]: { loadSession: false, session: { resume: false } },
                  },
                }
              : {}),
          },
          adapters,
        );
        // Resume reads the same workspace the session was created with.
        const cwd = tmp('runskein-uatx-');
        const s = await hub.session({ engine: adapters[0]!.id, cwd });
        await s.prompt('t1');
        await s.prompt('t2');
        await s.prompt('t3');
        const before = s.usage();
        expect(before, `${source} pre-resume`).toEqual({ input: 600 });
        await s.close();

        const r = await hub.session({ engine: adapters[0]!.id, cwd, resume: s.id });
        expect(r.resumeTier, `${source}/${tier}`).toBe(tier);
        // Resume introduces no regression of its own: the recovery continues
        // from the recovered value (the narrow claim design §4.2 makes).
        expect(r.usage(), `${source}/${tier} after resume`).toEqual({ input: 600 });
        await r.prompt('t4');
        expect(r.usage(), `${source}/${tier} final`).toEqual({ input: 1000 });
        await r.close();
      }
    }
  });

  it('UA-TX-06: forks start at zero on both sources and count only their own turns', async () => {
    for (const source of ['meta', 'default'] as const) {
      const env =
        source === 'meta'
          ? {
              MOCK_PROMPT_META_PLAN: json([
                { inputTokens: 100 },
                { inputTokens: 200 },
                { inputTokens: 50 },
              ]),
            }
          : {
              MOCK_USAGE_PLAN: json([
                [{ inputTokens: 100 }],
                [{ inputTokens: 300 }],
                [{ inputTokens: 50 }],
              ]),
            };
      const adapters = source === 'meta' ? [declared(env, 'meta', PER_TURN_META)] : [mockAdapter(env)];
      const hub = makeHub({}, {}, adapters);
      const parent = await hub.session({ engine: adapters[0]!.id, cwd: tmp('runskein-uatx-') });
      await parent.prompt('p1');
      await parent.prompt('p2');
      expect(parent.usage(), `${source} parent`).toEqual({ input: 300 });

      const child = await parent.fork();
      // No inheritance on either source: the fork starts at zero…
      expect(child.usage(), `${source} fork start`).toEqual({});
      // …and counts only its own turn (the third scripted report, 50).
      await child.prompt('c1');
      expect(child.usage(), `${source} fork after own turn`).toEqual({ input: 50 });
      // And the parent learned nothing from the child.
      expect(parent.usage()).toEqual({ input: 300 });
      await child.close();
      await parent.close();
    }
  });
});

describe('live stream parity (UA-LIVE-STREAM)', () => {
  it("runskein's own events reach on('update') as the transcript holds them", async () => {
    const hub = makeHub({}, {}, [
      declared({ MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }]) }, 'meta', PER_TURN_META),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uastream-') });
    // Subscribed after creation, so the session-meta event the constructor
    // recorded is out of scope here; everything from the prompt on is not.
    const live: TranscriptEvent[] = [];
    s.on('update', (e) => live.push(e));
    await s.prompt('one');

    const synthetic = live.filter((e) => isSyntheticUsageUpdate(e.update));
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.usage).toEqual({ input: 100 });
    // The prompt runskein echoed into the transcript is on the live stream too,
    // marked so a host that draws its own input can tell it apart from a user
    // chunk the engine sent.
    const echoes = live.filter((e) => e.update.sessionUpdate === 'user_message_chunk');
    expect(echoes).toHaveLength(1);
    expect(isPromptEcho(echoes[0]!.update)).toBe(true);
    expect(
      isPromptEcho({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }),
    ).toBe(false);

    // Same events, same order, same seqs as the transcript from that point on.
    const persisted = (await collect(s.transcript())).filter((e) => e.seq >= live[0]!.seq);
    expect(live.map((e) => e.seq)).toEqual(persisted.map((e) => e.seq));
    expect(live.map((e) => e.update.sessionUpdate)).toEqual(persisted.map((e) => e.update.sessionUpdate));
    await s.close();
  });

  it('a listener reading s.status while handling a status event sees the new one', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uastatus-') });
    const seen: Array<{ meta: string | undefined; status: string }> = [];
    s.on('update', (e) => {
      const meta = readSessionMeta(e.update)?.status;
      if (meta !== undefined) seen.push({ meta, status: s.status });
    });
    await s.prompt('one');
    await s.close();
    expect(seen).toContainEqual({ meta: 'closed', status: 'closed' });
  });

  it('a cancel raised from the prompt echo still cancels the turn', async () => {
    // The echo is the first event of a turn and reaches listeners before the
    // prompt is written, so a naive cancel would cancel nothing and the turn
    // would run to end_turn.
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '300' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uacancel-') });
    const un = s.on('update', (e) => {
      if (isPromptEcho(e.update)) {
        un();
        void s.cancel();
      }
    });
    const r = await s.prompt('one');
    expect(r.stopReason).toBe('cancelled');
    await s.close();
  });

  it('a cancel issued before the prompt reaches the engine still cancels the turn', async () => {
    // The turn becomes the queue's active one before its prompt is written, so
    // a cancel arriving in that window used to reach an engine that had
    // nothing to cancel — and the turn then ran to end_turn.
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '300' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uapre-') });
    const turn = s.prompt('one');
    await s.cancel();
    expect((await turn).stopReason).toBe('cancelled');
    await s.close();
  });

  it('a close that wins before dispatch keeps the prompt from reaching the engine', async () => {
    const record = join(tmp('runskein-uaclosed-'), 'prompts.jsonl');
    const hub = makeHub({ MOCK_RECORD_PROMPT_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uaclosed-') });
    // Settled by close(), which takes several ticks — catch at submission so
    // the rejection is never momentarily unhandled.
    const turn = s.prompt('one').then(
      () => undefined,
      (e: unknown) => e,
    );
    await s.close();
    expect(await turn).toBeInstanceOf(CancelledError);
    expect(existsSync(record)).toBe(false);
  });

  it('closing records a status event that live subscribers also see', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uaclose-') });
    const live: TranscriptEvent[] = [];
    s.on('update', (e) => live.push(e));
    await s.close();
    const meta = live.filter((e) => readSessionMeta(e.update)?.status === 'closed');
    expect(meta).toHaveLength(1);
  });
});
