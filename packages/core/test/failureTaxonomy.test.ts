/**
 * Hermetic acceptance cases for the adapter-owned failure taxonomy.
 *
 * These tests use the scripted ACP agent so the classification contract is
 * independent of a provider account, rate limit, or expired real credential.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import claudeCode from '../../../adapters/claude-code/index.mjs';
import codex from '../../../adapters/codex/index.mjs';
import kimi from '../../../adapters/kimi/index.mjs';
import opencode from '../../../adapters/opencode/index.mjs';
import pi from '../../../adapters/pi/index.mjs';
import { classifyEngineFailure, compileErrorPatterns } from '../src/errorTaxonomy.js';
import { EngineOperationError, UnauthenticatedError } from '../src/errors.js';
import { inspectRouting } from '../src/hub.js';
import { Registry } from '../src/registry.js';
import type { IdleClock } from '../src/session/idleClock.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import type { TranscriptStore } from '../src/transcript/store.js';
import type { EngineAdapter, EngineErrorPattern } from '../src/types.js';
import { countSpawns, makeHub, mockAdapter, tmp } from './testkit.js';

const allCauses: EngineErrorPattern[] = [
  { cause: 'auth', match: 'Authentication required' },
  { cause: 'rate-limit', match: 'rate limit exceeded' },
  { cause: 'context', match: 'context window exceeded' },
  { cause: 'internal', match: 'engine unavailable' },
];

function failingAdapter(message: string, patterns: EngineErrorPattern[] = allCauses): EngineAdapter {
  return {
    ...mockAdapter({ MOCK_PROMPT_ERROR: message }),
    errorPatterns: patterns,
    detect: async () => ({ installed: true, authenticated: true, loginHint: 'mock acp --login' }),
  };
}

function manualIdleClock(): { clock: IdleClock; fire: () => Promise<void> } {
  let callback: (() => void) | undefined;
  return {
    clock: {
      schedule: (_ms, scheduled) => {
        callback = scheduled;
        return () => {
          if (callback === scheduled) callback = undefined;
        };
      },
    },
    fire: async () => {
      callback?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function failNthAppendStore(n: number, sentinel: Error): TranscriptStore {
  const events: TranscriptEvent[] = [];
  let appends = 0;
  return {
    async append(event) {
      appends++;
      if (appends === n) throw sentinel;
      events.push(event);
    },
    async *read(sessionId) {
      yield* events.filter((event) => event.sessionId === sessionId);
    },
    async sessions() {
      return [];
    },
    async digest(sessionId) {
      return { sessionId, throughSeq: 0, text: '' };
    },
    async delete() {},
  };
}

async function promptFailure(adapter: EngineAdapter): Promise<unknown> {
  const hub = makeHub({}, {}, [adapter]);
  const session = await hub.session({ engine: adapter.id, cwd: tmp('runskein-error-') });
  return session.prompt('trigger').catch((error: unknown) => error);
}

describe('ST-ERR-01 / ST-ERR-02 — adapter-owned prompt failures', () => {
  it.each([
    ['rate limit exceeded', 'rate-limit'],
    ['context window exceeded', 'context-exceeded'],
    ['engine unavailable', 'internal'],
  ] as const)('maps %s to EngineOperationError.kind=%s without an auth event', async (message, kind) => {
    const hub = makeHub({}, {}, [failingAdapter(message)]);
    const events: string[] = [];
    hub.on('engine:unauthenticated', ({ engineId }) => events.push(engineId));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-error-') });

    const error = await session.prompt('trigger').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/prompt', kind });
    expect(events).toEqual([]);
  });

  it('keeps unrecognised engine text as the plain fallback', async () => {
    const hub = makeHub({}, {}, [failingAdapter('opaque provider failure')]);
    const events: string[] = [];
    hub.on('engine:unauthenticated', ({ engineId }) => events.push(engineId));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-error-') });

    const error = await session.prompt('trigger').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/prompt' });
    expect((error as EngineOperationError).kind).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('maps recognised auth, invalidates detection, and only resumes after rescan', async () => {
    const traceFile = join(mkdtempSync(join(tmpdir(), 'runskein-auth-trace-')), 'trace.log');
    const adapter: EngineAdapter = {
      ...failingAdapter('Authentication required'),
      launch: {
        ...failingAdapter('Authentication required').launch,
        env: { MOCK_PROMPT_ERROR: 'Authentication required', MOCK_TRACE_FILE: traceFile },
      },
    };
    const hub = makeHub({}, {}, [adapter]);
    const events: string[] = [];
    hub.on('engine:unauthenticated', ({ engineId }) => events.push(engineId));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-auth-') });
    expect(countSpawns(traceFile)).toBe(1);

    const error = await session.prompt('trigger').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(error).toMatchObject({ engineId: 'mock', loginHint: 'mock acp --login' });
    expect(events).toEqual(['mock']);
    expect((await hub.engines()).find((engine) => engine.id === 'mock')).toMatchObject({
      authenticated: false,
    });
    await expect(hub.session({ engine: 'mock', cwd: tmp('runskein-auth-') })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(events).toEqual(['mock']);
    await expect(session.prompt('still blocked')).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(countSpawns(traceFile)).toBe(1);

    await hub.rescan();
    const fresh = await hub.session({ engine: 'mock', cwd: tmp('runskein-auth-') });
    expect(countSpawns(traceFile)).toBe(2);
    await fresh.close();
  });

  it('preserves auth typing when transcript persistence fails with the same turn', async () => {
    const sentinel = new Error('append failed');
    const hub = makeHub({}, { store: failNthAppendStore(2, sentinel) }, [
      failingAdapter('Authentication required'),
    ]);
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-auth-store-') });

    const error = await session.prompt('trigger').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as UnauthenticatedError).cause).toBeInstanceOf(AggregateError);
  });
});

describe('ST-ERR-03 — validated declarative pattern tables', () => {
  it('changes classification only when the adapter supplies a matching pattern', async () => {
    const plain = await promptFailure(failingAdapter('rate limit exceeded', []));
    const classified = await promptFailure(failingAdapter('rate limit exceeded'));

    expect(plain).toBeInstanceOf(EngineOperationError);
    expect((plain as EngineOperationError).kind).toBeUndefined();
    expect(classified).toMatchObject({ kind: 'rate-limit' });
  });

  it('invalidates an adapter whose regular expression cannot compile', async () => {
    const registry = new Registry({
      discovery: false,
      adapters: [
        {
          ...mockAdapter(),
          errorPatterns: [{ cause: 'auth', match: 'auth', flags: '[' }],
        },
      ],
    });

    expect(await registry.adapters()).toEqual(new Map());
    expect(await registry.invalidCandidates()).toMatchObject([
      { id: 'mock', health: 'invalid', error: expect.stringContaining('invalid error pattern') },
    ]);
  });

  it('keeps the compiled table available to sessions registered before a rescan', async () => {
    const registry = new Registry({
      discovery: false,
      adapters: [failingAdapter('Authentication required')],
    });
    const adapter = (await registry.adapters()).get('mock')!;

    registry.rescan();

    expect(registry.classifyFailure(adapter, new Error('Authentication required'))).toBe('auth');
  });

  it('does not let a stale detect result overwrite the post-rescan login hint', async () => {
    let resolveFirst!: (result: { installed: true; loginHint: string }) => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let calls = 0;
    const registry = new Registry({
      discovery: false,
      adapters: [
        {
          ...mockAdapter(),
          detect: async () => {
            calls++;
            if (calls === 1) {
              signalFirstStarted();
              return new Promise((resolve) => {
                resolveFirst = resolve;
              });
            }
            return { installed: true, loginHint: 'fresh login' };
          },
        },
      ],
    });
    await registry.adapters();

    const stale = registry.detect('mock');
    await firstStarted;
    registry.rescan();
    await registry.detect('mock');
    resolveFirst({ installed: true, loginHint: 'stale login' });
    await stale;

    expect(registry.markUnauthenticated('mock')).toMatchObject({ loginHint: 'fresh login' });
  });

  it('releases a reactivation binding when config replay finds expired credentials', async () => {
    const idle = manualIdleClock();
    const adapter: EngineAdapter = {
      ...mockAdapter({ MOCK_CONFIG_ERROR_ON_WRITE: '2' }),
      errorPatterns: allCauses,
      detect: async () => ({ installed: true, authenticated: true, loginHint: 'mock acp --login' }),
    };
    const hub = makeHub({}, { defaults: { sessionIdleTimeoutMs: 1 }, idleClock: idle.clock }, [adapter]);
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-config-auth-') });
    await session.setConfig({ model: 'm2' });

    await idle.fire();
    const error = await session.prompt('reactivate').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect(hub[inspectRouting]()).toEqual([]);
  });

  it('checks the complete cause chain and keeps global patterns deterministic', () => {
    const patterns = compileErrorPatterns([{ cause: 'internal', match: 'root failure', flags: 'g' }]);
    const root = new Error('root failure');
    const outer = Object.assign(new Error('outer wrapper'), { cause: root });

    expect(classifyEngineFailure(patterns, outer)).toBe('internal');
    expect(classifyEngineFailure(patterns, outer)).toBe('internal');
  });

  it('ships an auth pattern in every bundled adapter', () => {
    for (const adapter of [codex, kimi, opencode, claudeCode]) {
      expect(adapter.errorPatterns?.some((pattern) => pattern.cause === 'auth')).toBe(true);
    }
  });

  /**
   * Every spent-quota refusal kimi has actually returned, with the date it was
   * captured. The account's login was valid on both occasions.
   *
   * A table rather than a constant because the second entry exists: the first
   * declaration was written from the 2026-08-25 payload alone, and the
   * 2026-08-31 rewording broke both of its fragments at once, sending a spent
   * quota back down the auth path in production. The pattern is now anchored on
   * what these share rather than on fragments of any one of them (decision
   * 044), and the next field report should be a line here.
   */
  const KIMI_QUOTA_SPENT: [captured: string, payload: string][] = [
    [
      '2026-08-25',
      "Authentication required: 403 You've reached your usage limit for this billing cycle. " +
        'Your quota will be refreshed in the next cycle. To continue now, purchase extra usage ' +
        'or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota',
    ],
    [
      '2026-08-31',
      "Authentication required: 403 You've reached your weekly (7-day) usage limit. " +
        'Your quota will reset when the current 7-day window ends. To continue now, purchase ' +
        'extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota',
    ],
  ];

  it.each(KIMI_QUOTA_SPENT)(
    'reads the %s spent kimi quota as rate-limit, not as a dead credential',
    (_captured, payload) => {
      const patterns = compileErrorPatterns(kimi.errorPatterns);
      expect(classifyEngineFailure(patterns, new Error(payload))).toBe('rate-limit');
    },
  );

  it('still reads a bare credential failure as auth, and claims nothing else', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    expect(classifyEngineFailure(patterns, new Error('Authentication required'))).toBe('auth');
    // The rate-limit pattern claims nothing it was not measured against. The
    // last one is the guard on the pattern's width, and it is why `usage limit`
    // is never matched on its own: it also names a *configured* limit, which is
    // not a refusal. Widening the declaration toward the general turns this red.
    for (const other of [
      'context window exceeded',
      'engine unavailable',
      'ECONNRESET',
      "failed to parse the 'usage limit' setting",
    ]) {
      expect(classifyEngineFailure(patterns, new Error(other))).toBeUndefined();
    }
  });

  it('depends on declaration order: the auth pattern alone claims those messages', () => {
    // The negative half. kimi prefixes an upstream refusal with
    // "Authentication required:" whatever its cause, so both patterns match a
    // quota message and only the order keeps it out of the auth path — which
    // invalidates the login and retires the engine.
    const authOnly = compileErrorPatterns([{ cause: 'auth', match: 'Authentication required' }]);
    for (const [, payload] of KIMI_QUOTA_SPENT) {
      expect(classifyEngineFailure(authOnly, new Error(payload))).toBe('auth');
    }
  });

  it('survives a rewording that keeps any single anchor', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    // One line per anchor, each carrying that anchor and no other, so a
    // declaration that quietly loses one of the four turns exactly one red
    // rather than hiding behind the three that still match.
    const perAnchor = [
      'Authentication required: 403 This account has reached your usage limit; try later.',
      'Authentication required: 403 Out of credit. Your quota will reset shortly.',
      'Authentication required: 403 Out of credit — purchase extra usage to continue.',
      'Authentication required: 403 See https://www.kimi.com/membership/subscription?tab=quota',
    ];
    for (const message of perAnchor) {
      expect(classifyEngineFailure(patterns, new Error(message))).toBe('rate-limit');
    }
  });

  it('falls back to auth when a rewording drops every anchor', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    // Still the documented other branch: four anchors make this less likely,
    // not impossible, and no hermetic suite can foresee the wording that does
    // it. This is what a field report looks like before it is one.
    const reworded = 'Authentication required: 403 Monthly allowance exhausted; buy more.';
    expect(classifyEngineFailure(patterns, new Error(reworded))).toBe('auth');
  });

  it('leaves everything standing when the same message is classified rate-limit', async () => {
    // The mirror of the auth case above, and the assertion that was missing:
    // decision 037 promised that a spent quota keeps the login, the session and
    // the process, but only the *classification* was ever checked. Measured
    // live against a real spent kimi quota on 2026-08-31, every line below was
    // the opposite before the declaration was fixed — UnauthenticatedError, a
    // failed session, an engine:unauthenticated event and a dead engine.
    //
    // The payload carries kimi's "Authentication required:" prefix on purpose:
    // both patterns match it, so this also pins the declaration order.
    const traceFile = join(mkdtempSync(join(tmpdir(), 'runskein-quota-trace-')), 'trace.log');
    const quota = KIMI_QUOTA_SPENT[1]![1];
    const base = failingAdapter(quota, kimi.errorPatterns);
    const adapter: EngineAdapter = {
      ...base,
      launch: { ...base.launch, env: { MOCK_PROMPT_ERROR: quota, MOCK_TRACE_FILE: traceFile } },
    };
    const hub = makeHub({}, {}, [adapter]);
    const events: string[] = [];
    hub.on('engine:unauthenticated', ({ engineId }) => events.push(engineId));
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    expect(countSpawns(traceFile)).toBe(1);

    const error = await session.prompt('trigger').catch((failure: unknown) => failure);

    // UnauthenticatedError does not extend EngineOperationError, so this line
    // alone says which of the two paths ran.
    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/prompt', kind: 'rate-limit' });
    // Nothing was torn down: no event, the login still stands, and a second
    // session neither rejects nor needs a rescan to reach the same process.
    expect(events).toEqual([]);
    const entry = (await hub.engines()).find((engine) => engine.id === 'mock');
    expect(entry).toBeDefined();
    expect(entry?.authenticated).not.toBe(false);
    const second = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    expect(countSpawns(traceFile)).toBe(1);
    // The first session is still usable — a throttled turn is not a crash, so
    // it fails again the same way rather than rejecting as a dead session.
    const again = await session.prompt('trigger again').catch((failure: unknown) => failure);
    expect(again).toMatchObject({ kind: 'rate-limit' });
    await second.close();
    await session.close();
  });

  /**
   * What pi returned on 2026-08-25 once its automatic retries were spent.
   * Replayed like kimi's, with the same reach and the same limit.
   */
  const PI_THROTTLED = 'Internal error: pi ended the turn with an error: 429 status code (no body)';

  it('reads a throttled pi turn as rate-limit rather than as no cause at all', () => {
    const patterns = compileErrorPatterns(pi.errorPatterns);
    expect(classifyEngineFailure(patterns, new Error(PI_THROTTLED))).toBe('rate-limit');
    expect(classifyEngineFailure(patterns, new Error('credentials_not_configured'))).toBe('auth');
    // The digits alone are not the signal. Word boundaries do not separate a
    // status code from a token count, a port or a path segment, so the words pi
    // puts around it are part of the pattern.
    for (const other of [
      'wrote 1429 tokens',
      'wrote 429 tokens',
      'connect ECONNREFUSED 127.0.0.1:429',
      'GET /jobs/429/result failed',
    ]) {
      expect(classifyEngineFailure(patterns, new Error(other))).toBeUndefined();
    }
  });

  it('declares rate-limit ahead of auth wherever an adapter classifies both', () => {
    for (const adapter of [codex, kimi, opencode, claudeCode, pi]) {
      const causes = (adapter.errorPatterns ?? []).map((pattern) => pattern.cause);
      if (!causes.includes('rate-limit')) continue;
      expect(causes.indexOf('rate-limit')).toBeLessThan(causes.indexOf('auth'));
    }
    // kimi and pi are the engines whose rate-limited payloads have been
    // measured; the rest declare no rate-limit pattern until theirs have been.
    expect((kimi.errorPatterns ?? []).map((p) => p.cause)).toEqual(['rate-limit', 'auth']);
    expect((pi.errorPatterns ?? []).map((p) => p.cause)).toEqual(['rate-limit', 'auth']);
  });
});
