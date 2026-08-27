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
   * What kimi returned on 2026-08-25 with the account's quota spent and its
   * login perfectly valid. Replaying it pins the pattern against this recorded
   * payload: loosening or dropping the rate-limit declaration turns the case
   * red.
   *
   * It cannot detect kimi rewording the message. What a rewording does depends
   * on whether it keeps a matched fragment, and the two cases below pin both
   * branches — neither is a failure the suite could notice on its own.
   */
  const KIMI_QUOTA_SPENT =
    "Authentication required: 403 You've reached your usage limit for this billing cycle. " +
    'Your quota will be refreshed in the next cycle. To continue now, purchase extra usage ' +
    'or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota';

  it('reads a spent kimi quota as rate-limit, not as a dead credential', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    expect(classifyEngineFailure(patterns, new Error(KIMI_QUOTA_SPENT))).toBe('rate-limit');
    // A real credential failure still reaches the auth pattern behind it.
    expect(classifyEngineFailure(patterns, new Error('Authentication required'))).toBe('auth');
    // And the rate-limit pattern claims nothing it was not measured against.
    // The last one is the guard on the pattern's width: `usage limit` alone
    // reads a sentence about a configured limit as a refusal, so loosening the
    // declaration toward the general turns this red.
    for (const other of [
      'context window exceeded',
      'engine unavailable',
      'ECONNRESET',
      "failed to parse the 'usage limit' setting",
    ]) {
      expect(classifyEngineFailure(patterns, new Error(other))).toBeUndefined();
    }
  });

  it('depends on declaration order: the auth pattern alone claims that message', () => {
    // The negative half of the case above. kimi prefixes an upstream refusal
    // with "Authentication required:" whatever its cause, so both patterns
    // match this message and only the order keeps the quota case out of the
    // auth path — which invalidates the login and retires the engine.
    const authOnly = compileErrorPatterns([{ cause: 'auth', match: 'Authentication required' }]);
    expect(classifyEngineFailure(authOnly, new Error(KIMI_QUOTA_SPENT))).toBe('auth');
  });

  it('keeps classifying a reworded quota message that still names the condition', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    // A plausible rewrite of the payload above, keeping one of the two
    // statements kimi makes about the condition. The pattern matches that
    // fragment, not the sentence around it, so this still reads as rate-limit.
    const reworded =
      'Authentication required: 403 This account has reached your usage limit; try again next cycle.';
    expect(classifyEngineFailure(patterns, new Error(reworded))).toBe('rate-limit');
  });

  it('falls back to auth when a rewording drops both fragments', () => {
    const patterns = compileErrorPatterns(kimi.errorPatterns);
    // The documented other branch, and the reason a rewording is a field
    // report: nothing here is wrong, and the spent quota is a teardown again.
    const reworded = 'Authentication required: 403 Monthly allowance exhausted; purchase more.';
    expect(classifyEngineFailure(patterns, new Error(reworded))).toBe('auth');
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
