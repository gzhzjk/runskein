/**
 * Adapter-declared usage accounting (decision 033): declaration validation,
 * resolution/normalization, and turn/session semantics. Transcript, resume and
 * source-exclusivity cases live in usageTranscript.test.ts.
 *
 * Per-turn reporting drives a `prompt_response_meta` source on purpose: the
 * schema refuses `usage_update` + `per-turn` (UA-DECL-04), so a notification
 * carrier cannot express these scripts.
 */
import { describe, expect, it } from 'vitest';
import { Registry, validateAdapter } from '../src/registry.js';
import { recoverAccounting } from '../src/session/resume.js';
import { foldUsageReport, isSyntheticUsageUpdate } from '../src/transcript/event.js';
import type { TranscriptEvent, UsageMapping } from '../src/transcript/event.js';
import type { EngineAdapter } from '../src/types.js';
import { collect, declared, json, makeHub, mockAdapter, PER_TURN_META, tmp } from './testkit.js';

/** codex's declaration verbatim (adapters/codex/index.mjs). */
const CODEX_LIKE: UsageMapping = {
  source: { kind: 'prompt_response_meta', path: ['_meta', 'quota', 'token_count'] },
  tokens: { cacheRead: ['cachedInputTokens'], thought: ['reasoningOutputTokens'] },
  semantics: 'per-turn',
};

/**
 * Verbatim copy of the token_count blob in codex's captured probe response
 * (`docs/conformance/codex.raw.json`). The copy buys realism only; noticing
 * codex changing its wire is UA-LIVE-01's and UA-MTX-01's job.
 */
const CODEX_TOKEN_COUNT = {
  totalTokens: 19269,
  inputTokens: 12352,
  cachedInputTokens: 6912,
  outputTokens: 5,
  reasoningOutputTokens: 0,
};

describe('declaration validation (UA-DECL)', () => {
  it('UA-DECL-01: malformed usage declarations load as invalid with the offending field named', async () => {
    const bad = (usage: unknown): EngineAdapter => ({ ...mockAdapter({}, 'bad'), usage }) as EngineAdapter;
    // The error must name BOTH legal kinds: it is the union that refused the
    // value, so an unrelated message naming neither cannot satisfy this.
    const cases: Array<[unknown, RegExp]> = [
      [
        { source: { kind: 'wire_gossip' }, semantics: 'cumulative' },
        /usage_update[\s\S]*prompt_response_meta|prompt_response_meta[\s\S]*usage_update/,
      ],
      [
        { source: { kind: 'prompt_response_meta', path: [] }, semantics: 'cumulative' },
        /at least 1 element/,
      ],
      [{ source: { kind: 'usage_update' } }, /semantics/],
      [
        { source: { kind: 'usage_update' }, semantics: 'cumulative', tokens: { prompt: ['x'] } },
        /unknown runskein Usage token key 'prompt'/,
      ],
    ];
    for (const [usage, pattern] of cases) {
      const r = new Registry({ adapters: [bad(usage)], discovery: false });
      expect([...(await r.adapters()).keys()], JSON.stringify(usage)).toEqual([]);
      const invalid = await r.invalidCandidates();
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toMatchObject({ id: 'bad', health: 'invalid' });
      expect(invalid[0]!.error).toMatch(pattern);
    }
  });

  it('UA-DECL-02: an adapter declaring nothing behaves exactly like the explicit cumulative default', async () => {
    // Cumulative totals as an engine that reports tokens through
    // usage_update would stream them.
    const plan = [[{ inputTokens: 100 }], [{ inputTokens: 300, outputTokens: 30 }]];
    const env = { MOCK_USAGE_PLAN: json(plan) };

    // The default run…
    const defaultHub = makeHub(env);
    const d = await defaultHub.session({ engine: 'mock', cwd: tmp('runskein-uadecl-') });
    const dr1 = await d.prompt('one');
    const dr2 = await d.prompt('two');

    // …must equal the same run over an adapter that spells the default out.
    const explicitHub = makeHub({}, {}, [
      declared(env, 'explicit-mock', { source: { kind: 'usage_update' }, semantics: 'cumulative' }),
    ]);
    const e = await explicitHub.session({ engine: 'explicit-mock', cwd: tmp('runskein-uadecl-') });
    const er1 = await e.prompt('one');
    const er2 = await e.prompt('two');

    // Replace semantics on the session counter, delta on the turn value —
    // today's behaviour, unchanged by the declaration machinery.
    for (const [r1, r2] of [
      [dr1, dr2],
      [er1, er2],
    ]) {
      expect(r1.usage).toEqual({ input: 100 });
      // The engine reported no total in either report, so the fold derived one
      // (300+30) on the second; the turn-open snapshot had none yet, so the
      // differenced turn carries it whole.
      expect(r2.usage).toEqual({ input: 200, output: 30, total: 330 });
    }
    expect(d.usage()).toEqual(e.usage());
    expect(d.usage()).toEqual({ input: 300, output: 30, total: 330 });

    // Byte-identical transcripts where the declaration could matter: the
    // engine-sent usage_update events verbatim, with their envelope view of
    // the running total — and nothing synthesized beside them.
    const project = (events: TranscriptEvent[]) =>
      JSON.stringify(
        events
          .filter((ev) => ev.update.sessionUpdate === 'usage_update')
          .map((ev) => ({ update: ev.update, usage: ev.usage })),
      );
    const de = await collect(d.transcript());
    const ee = await collect(e.transcript());
    expect(project(de)).toBe(project(ee));
    expect(de.filter((ev) => ev.update.sessionUpdate === 'usage_update')).toHaveLength(2);
    await d.close();
    await e.close();
  });

  it('UA-DECL-03: declared aliases extend the built-in table, never replace it', async () => {
    const hub = makeHub({}, {}, [
      declared(
        { MOCK_USAGE_PLAN: json([[{ reasoningOutputTokens: 7, inputTokens: 100, outputTokens: 5 }]]) },
        'additive',
        {
          source: { kind: 'usage_update' },
          tokens: { thought: ['reasoningOutputTokens'] },
          semantics: 'cumulative',
        },
      ),
    ]);
    const s = await hub.session({ engine: 'additive', cwd: tmp('runskein-uadecl-') });
    const r = await s.prompt('one');
    // thought came from the declared alias; input/output through built-ins;
    // total derived from the built-in read.
    expect(r.usage).toEqual({ input: 100, output: 5, total: 105, thought: 7 });
    expect(s.usage()).toEqual({ input: 100, output: 5, total: 105, thought: 7 });
    await s.close();
  });

  it('UA-DECL-04: usage_update + per-turn is refused as a combination at load', async () => {
    const usage = { source: { kind: 'usage_update' }, semantics: 'per-turn' };
    let message = '';
    try {
      validateAdapter({ ...mockAdapter({}, 'combo'), usage });
    } catch (e) {
      message = (e as Error).message;
    }
    // The error names the PAIRING: both halves are individually legal, so
    // blaming either field alone sends the adapter author to the wrong fix.
    expect(message).toMatch(/invalid combination usage_update \+ per-turn/);

    // Registry-level: the pairing fails the adapter, each half alone passes.
    const r = new Registry({
      adapters: [
        { ...mockAdapter({}, 'combo'), usage } as EngineAdapter,
        {
          ...mockAdapter({}, 'ok-cum'),
          usage: { source: { kind: 'usage_update' }, semantics: 'cumulative' },
        },
        {
          ...mockAdapter({}, 'ok-meta'),
          usage: { ...PER_TURN_META, source: { kind: 'prompt_response_meta', path: ['_meta'] } },
        },
      ],
      discovery: false,
    });
    expect([...(await r.adapters()).keys()].sort()).toEqual(['ok-cum', 'ok-meta']);
    expect((await r.invalidCandidates())[0]?.error).toMatch(/invalid combination usage_update \+ per-turn/);

    // Why the refusal exists: replay replaces within a segment, so three
    // per-turn usage_update turns of 100/200/300 would recover as 300.
  });

  it('UA-DECL-04b: replay of per-turn-shaped usage_update events recovers only the last', () => {
    // Documents the loss the refusal prevents (design §3.1): raw per-turn
    // numbers in the verbatim carrier cannot survive recovery.
    const ev = (seq: number, inputTokens: number): TranscriptEvent => ({
      seq,
      ts: seq,
      sessionId: 's',
      engineId: 'e',
      update: { sessionUpdate: 'usage_update', inputTokens },
    });
    const recovered = recoverAccounting([ev(1, 100), ev(2, 200), ev(3, 300)]);
    // Replay replaces within a segment: 300 recovers, not 600 — exactly the
    // loss the schema's refusal keeps out of real transcripts.
    expect(recovered.currentUsage).toEqual({ input: 300 });
  });
});

describe('resolution and normalization (UA-MAP)', () => {
  it('UA-MAP-01: the codex path walk resolves the captured numbers onto the public surface', async () => {
    const hub = makeHub({}, {}, [
      declared(
        { MOCK_PROMPT_META_PLAN: json([{ quota: { token_count: CODEX_TOKEN_COUNT } }]) },
        'codex-like',
        CODEX_LIKE,
      ),
    ]);
    const s = await hub.session({ engine: 'codex-like', cwd: tmp('runskein-uamap-') });
    const r = await s.prompt('one');
    // The reported total wins (it is not input+output); cacheRead/thought come
    // through the declared aliases.
    expect(r.usage).toEqual({ input: 12352, output: 5, total: 19269, cacheRead: 6912, thought: 0 });
    expect(s.usage()).toEqual(r.usage);
    await s.close();
  });

  it('UA-MAP-02: an absent or non-object path yields absent usage — no error, no zeros, no coercion', async () => {
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_PROMPT_META_PLAN: json([
            null, // no _meta at all
            { quota: { token_count: 42 } }, // resolves to a number
            { quota: { token_count: 'nope' } }, // resolves to a string
          ]),
        },
        'codex-like',
        CODEX_LIKE,
      ),
    ]);
    const s = await hub.session({ engine: 'codex-like', cwd: tmp('runskein-uamap-') });
    for (let i = 0; i < 3; i++) {
      const r = await s.prompt(`turn${i}`);
      expect(r.usage, `turn ${i}`).toBeUndefined();
    }
    expect(s.usage()).toEqual({});
    await s.close();
  });

  it('UA-MAP-03: string, null, and NaN fields are treated as absent while numeric siblings resolve', async () => {
    // End-to-end for the values JSON can carry…
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_PROMPT_META_PLAN: json([
            { quota: { token_count: { inputTokens: '12352', outputTokens: 5 } } },
            { quota: { token_count: { cachedInputTokens: null, inputTokens: 7 } } },
          ]),
        },
        'codex-like',
        CODEX_LIKE,
      ),
    ]);
    const s = await hub.session({ engine: 'codex-like', cwd: tmp('runskein-uamap-') });
    const r1 = await s.prompt('one');
    expect(r1.usage).toEqual({ output: 5 }); // "12352" never parsed; no total derived without numeric input
    const r2 = await s.prompt('two');
    expect(r2.usage).toEqual({ input: 7 }); // null cacheRead stays absent
    await s.close();

    // …NaN and Infinity directly at the interpreter, because JSON cannot
    // carry either on the wire (JSON.parse has no way to produce them).
    const nanReport = foldUsageReport(
      undefined,
      { reasoningOutputTokens: NaN, outputTokens: 2 },
      {
        thought: ['reasoningOutputTokens'],
      },
    );
    expect(nanReport).toEqual({ output: 2 });

    const infReport = foldUsageReport(undefined, { inputTokens: Infinity, outputTokens: 3 });
    expect(infReport).toEqual({ output: 3 });
  });

  it('UA-MAP-04: a payload whose ONLY recognizable fields are declared aliases still counts', async () => {
    const hub = makeHub({}, {}, [
      declared({ MOCK_USAGE_PLAN: json([[{ reasoningOutputTokens: 4 }]]) }, 'gate', {
        source: { kind: 'usage_update' },
        tokens: { thought: ['reasoningOutputTokens'] },
        semantics: 'cumulative',
      }),
    ]);
    const s = await hub.session({ engine: 'gate', cwd: tmp('runskein-uamap-') });
    const r = await s.prompt('one');
    // Without the recognition gate counting declared names, foldUsage would
    // early-return "no tokens reported" and this would be undefined.
    expect(r.usage).toEqual({ thought: 4 });
    expect(s.usage()).toEqual({ thought: 4 });
    await s.close();
  });

  it('UA-MAP-05: reported total wins, input+output derives one, output alone leaves total absent', async () => {
    const hub = makeHub({}, {}, [
      declared(
        {
          MOCK_PROMPT_META_PLAN: json([
            { inputTokens: 10, outputTokens: 2, totalTokens: 99 }, // engine's own total wins
            { inputTokens: 20, outputTokens: 4 }, // derived: 24
            { outputTokens: 6 }, // no input → total absent
          ]),
        },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uamap-') });
    const r1 = await s.prompt('one');
    expect(r1.usage).toEqual({ input: 10, output: 2, total: 99 });
    const r2 = await s.prompt('two');
    expect(r2.usage).toEqual({ input: 20, output: 4, total: 24 });
    const r3 = await s.prompt('three');
    expect(r3.usage).toEqual({ output: 6 });
    expect(r3.usage!.total).toBeUndefined();
    // Session counter adds per-turn reports; the derived total folds in, the
    // absent one leaves the previous value untouched.
    expect(s.usage()).toEqual({ input: 30, output: 12, total: 123 });
    await s.close();
  });
});

describe('semantics (UA-SEM)', () => {
  it('UA-SEM-01: per-turn reports keep the turn value AND accumulate the session counter', async () => {
    const hub = makeHub({}, {}, [
      declared(
        { MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }, { inputTokens: 200 }, { inputTokens: 300 }]) },
        'meta',
        PER_TURN_META,
      ),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasem-') });
    const turns = [];
    for (let i = 0; i < 3; i++) turns.push(await s.prompt(`t${i}`));
    expect(turns.map((r) => r.usage!.input)).toEqual([100, 200, 300]);
    // The failing oracle without add-at-settlement: 300 ("the last turn"
    // masquerading as the session total).
    expect(s.usage().input).toBe(600);
    await s.close();
  });

  it('UA-SEM-02: cumulative reports yield a differenced turn value against the turn-open snapshot', async () => {
    const hub = makeHub({
      MOCK_USAGE_PLAN: json([[{ inputTokens: 100 }], [{ inputTokens: 300 }], [{ inputTokens: 600 }]]),
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uasem-') });
    const turns = [];
    for (let i = 0; i < 3; i++) turns.push(await s.prompt(`t${i}`));
    expect(turns.map((r) => r.usage!.input)).toEqual([100, 200, 300]);
    expect(s.usage().input).toBe(600);
    await s.close();
  });

  it('UA-SEM-03: an engine-side counter reset clamps the turn at zero and replaces the session counter', async () => {
    const hub = makeHub({ MOCK_USAGE_PLAN: json([[{ inputTokens: 600 }], [{ inputTokens: 50 }]]) });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uasem-') });
    const r1 = await s.prompt('big');
    expect(r1.usage).toEqual({ input: 600 });
    const r2 = await s.prompt('reset');
    // Clamped per field, never negative.
    expect(r2.usage).toEqual({ input: 0 });
    // Session counter does what it does today — replace. This design pins
    // that, it does not claim within-segment monotonicity (design §4.2).
    expect(s.usage().input).toBe(50);
    await s.close();
  });

  it('UA-SEM-04: several updates inside one turn diff against the turn-open snapshot', async () => {
    const hub = makeHub({
      MOCK_USAGE_PLAN: json([[{ inputTokens: 100 }], [{ inputTokens: 300 }, { inputTokens: 350 }]]),
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uasem-') });
    await s.prompt('one');
    const r2 = await s.prompt('two');
    // Delta vs turn-open (350-100), not vs the previous update (350-300).
    expect(r2.usage).toEqual({ input: 250 });
    expect(s.usage().input).toBe(350);
    await s.close();
  });

  it('UA-SEM-05: a turn with no report leaves TurnResult.usage absent and usage() unchanged, both semantics', async () => {
    // Cumulative (default): plan covers only the first turn.
    const cumHub = makeHub({ MOCK_USAGE_PLAN: json([[{ inputTokens: 100 }]]) });
    const c = await cumHub.session({ engine: 'mock', cwd: tmp('runskein-uasem-') });
    await c.prompt('reported');
    const silentCum = await c.prompt('silent');
    expect(silentCum.usage).toBeUndefined();
    expect(c.usage()).toEqual({ input: 100 });
    await c.close();

    // Per-turn (_meta): null element means no _meta.
    const metaHub = makeHub({}, {}, [
      declared({ MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }, null]) }, 'meta', PER_TURN_META),
    ]);
    const m = await metaHub.session({ engine: 'meta', cwd: tmp('runskein-uasem-') });
    await m.prompt('reported');
    const silentMeta = await m.prompt('silent');
    expect(silentMeta.usage).toBeUndefined();
    expect(m.usage()).toEqual({ input: 100 });
    await m.close();
  });

  it('UA-SEM-06: a non-sum total is differenced, never re-derived from input+output', async () => {
    // pi's real shape (probe capture): total ≠ input + output.
    const hub = makeHub({
      MOCK_USAGE_PLAN: json([
        [{ inputTokens: 16910, outputTokens: 55, totalTokens: 55877 }],
        [{ inputTokens: 17000, outputTokens: 66, totalTokens: 56100 }],
      ]),
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-uasem-') });
    await s.prompt('one');
    const r2 = await s.prompt('two');
    // Difference of the engine's own totals (56100-55877), not input+output
    // deltas (90+11=101), which would fabricate a number the engine never said.
    expect(r2.usage!.total).toBe(223);
    expect(r2.usage!.total).not.toBe(r2.usage!.input! + r2.usage!.output!);
    expect(s.usage()).toEqual({ input: 17000, output: 66, total: 56100 });
    await s.close();
  });

  it('UA-SEM-07: cumulative semantics on a _meta source diffs the turn and replaces the counter', async () => {
    // A cumulative declaration on the prompt_response_meta carrier must behave
    // exactly like a usage_update reporter: turn = delta vs turn-open, session
    // counter = replace.
    const hub = makeHub({}, {}, [
      declared({ MOCK_PROMPT_META_PLAN: json([{ inputTokens: 100 }, { inputTokens: 300 }]) }, 'meta', {
        source: { kind: 'prompt_response_meta', path: ['_meta'] },
        semantics: 'cumulative',
      }),
    ]);
    const s = await hub.session({ engine: 'meta', cwd: tmp('runskein-uasem-') });
    const r1 = await s.prompt('one');
    expect(r1.usage).toEqual({ input: 100 });
    const r2 = await s.prompt('two');
    expect(r2.usage).toEqual({ input: 200 }); // not 300: differenced, not "the report"
    expect(s.usage()).toEqual({ input: 300 }); // replaced, not accumulated to 400

    // Synthesized events still carry the SESSION-cumulative value (100, 300),
    // which is what makes replay recover the session total adapter-free.
    const events = await collect(s.transcript());
    const carried = events
      .filter((e) => isSyntheticUsageUpdate(e.update))
      .map((e) => (e.update as Record<string, unknown>)['inputTokens']);
    expect(carried).toEqual([100, 300]);
    expect(recoverAccounting(events).currentUsage).toEqual({ input: 300 });
    await s.close();
  });
});
