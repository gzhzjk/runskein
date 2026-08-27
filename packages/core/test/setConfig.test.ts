/**
 * Configuration writes: descriptor-backed validation of setConfig, at session
 * creation and after it, and the providers section of describe(). What a write
 * then does to configState() is configState.test.ts's subject, not this file's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, NotSupportedError } from '../src/errors.js';
import type { EngineAdapter } from '../src/types.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { countSpawns, expectEventually, makeHub, mockAdapter, tmp } from './testkit.js';

describe('setConfig validated against describe()', () => {
  it('valid values apply: model by id, mode against descriptor.modes', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    await s.setConfig({ model: 'm2', mode: 'plan' });
    await s.close();
  });

  it('invalid select value fails fast with the valid values', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    const err = await s.setConfig({ model: 'bogus' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).key).toBe('model');
    expect((err as ConfigError).validValues).toEqual(['m1', 'm2']);
    await s.close();
  });

  it('invalid mode fails fast with the valid mode ids', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    const err = await s.setConfig({ mode: 'bogus' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).validValues).toEqual(['default', 'plan']);
    await s.close();
  });

  it('unknown key fails fast listing the known keys', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    const err = await s.setConfig({ warp_speed: '9' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).validValues).toEqual(['mode', 'model']);
    await s.close();
  });

  it("'reasoning' aliases the thought_level category; booleans type-check", async () => {
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    await s.setConfig({ reasoning: 'high', 'fast-mode': true });
    const bad = await s.setConfig({ reasoning: 'ultra' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(bad).toBeInstanceOf(ConfigError);
    expect((bad as ConfigError).validValues).toEqual(['low', 'high', 'max']);
    const notBool = await s.setConfig({ 'fast-mode': 'yes' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(notBool).toBeInstanceOf(ConfigError);
    expect((notBool as ConfigError).validValues).toEqual(['true', 'false']);
    await s.close();
  });

  it('mode on an engine without modes is NotSupportedError', async () => {
    const hub = makeHub({ MOCK_NO_MODES: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-m4-') });
    await expect(s.setConfig({ mode: 'plan' })).rejects.toBeInstanceOf(NotSupportedError);
    await s.close();
  });

  it('session({config}) validates at creation through the same path', async () => {
    const hub = makeHub();
    await expect(
      hub.session({ engine: 'mock', cwd: tmp('runskein-m4-'), config: { model: 'bogus' } }),
    ).rejects.toBeInstanceOf(ConfigError);
    const ok = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-m4-'),
      config: { model: 'm2' },
    });
    await ok.close();
  });
});

describe('describe() providers (Negotiated)', () => {
  it('maps providers/list when advertised', async () => {
    const hub = makeHub({ MOCK_PROVIDERS: '1' });
    const d = await hub.describe('mock');
    expect(d.providers).toEqual([
      {
        id: 'main',
        protocols: ['openai', 'anthropic'],
        required: true,
        current: { apiType: 'anthropic', baseUrl: 'https://api.example.test' },
      },
    ]);
  });

  it('absent capability: no providers field', async () => {
    const hub = makeHub();
    const d = await hub.describe('mock');
    expect(d.providers).toBeUndefined();
  });
});

describe('config an engine takes only at session creation', () => {
  /**
   * An adapter shaped like claude-code: it declares a thinking budget that
   * reaches the engine on the creation request and nowhere else.
   * @param record - file the fixture appends each session/new params to.
   * @returns the adapter.
   */
  function creationAdapter(record: string): EngineAdapter {
    return {
      ...mockAdapter({ MOCK_RECORD_NEW_FILE: record }),
      creationConfig: {
        reasoning: {
          meta: ['claudeCode', 'options', 'maxThinkingTokens'],
          values: { low: 4000, high: 32000 },
          description: 'Thinking budget, applied when the session is created',
        },
      },
    };
  }

  it('describe() reports it as settable at creation, beside the probed options', async () => {
    const hub = makeHub({}, {}, [creationAdapter(join(tmp('runskein-cc-'), 'new.jsonl'))]);
    const d = await hub.describe('mock');
    const reasoning = d.configOptions.find((o) => o.id === 'reasoning');
    expect(reasoning).toMatchObject({ settable: 'creation', category: 'thought_level' });
    expect(reasoning?.options).toEqual([
      { value: 'low', name: 'low' },
      { value: 'high', name: 'high' },
    ]);
    // The engine's own options are untouched and still settable any time.
    expect(d.configOptions.find((o) => o.id === 'model')?.settable).toBeUndefined();
  });

  it('rides the creation request at the declared path, mapped to the engine value', async () => {
    const record = join(tmp('runskein-cc-'), 'new.jsonl');
    const hub = makeHub({}, {}, [creationAdapter(record)]);
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cc-'),
      config: { reasoning: 'high' },
    });
    const params = JSON.parse(readFileSync(record, 'utf8').trim().split('\n')[0]!) as {
      _meta?: { claudeCode?: { options?: { maxThinkingTokens?: number } } };
    };
    expect(params._meta?.claudeCode?.options?.maxThinkingTokens).toBe(32_000);
    await s.close();
  });

  it('refuses a runtime write as NotSupportedError, naming the capability', async () => {
    const hub = makeHub({}, {}, [creationAdapter(join(tmp('runskein-cc-'), 'new.jsonl'))]);
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cc-') });
    const error = await s.setConfig({ reasoning: 'high' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as NotSupportedError).capability).toBe('config:reasoning@runtime');
    await s.close();
  });

  it('rejects an undeclared value before an engine is ever spawned', async () => {
    const trace = join(tmp('runskein-cc-'), 'spawns.log');
    const adapter = creationAdapter(join(tmp('runskein-cc-'), 'new.jsonl'));
    const hub = makeHub({}, {}, [
      { ...adapter, launch: { ...adapter.launch, env: { ...adapter.launch.env, MOCK_TRACE_FILE: trace } } },
    ]);
    const error = await hub
      .session({ engine: 'mock', cwd: tmp('runskein-cc-'), config: { reasoning: 'nope' } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).validValues).toEqual(['low', 'high']);
    expect(countSpawns(trace)).toBe(0);
  });

  it('leaves engines that declare nothing exactly as they were', async () => {
    const record = join(tmp('runskein-cc-'), 'new.jsonl');
    const hub = makeHub({ MOCK_RECORD_NEW_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cc-'), config: { model: 'm2' } });
    const params = JSON.parse(readFileSync(record, 'utf8').trim().split('\n')[0]!) as {
      _meta?: unknown;
    };
    // No _meta at all: an empty object is a different message on the wire.
    expect(params._meta).toBeUndefined();
    await s.close();
  });
});

describe('creation-time config survives a rebuild', () => {
  /**
   * The claude-code-shaped adapter again, with resume and load masked off so
   * every restore lands on the rebuilt tier — the one that creates a new
   * engine session and therefore has to send the creation `_meta` again.
   * @param record - file the fixture appends each session/new params to.
   * @returns the adapter.
   */
  function creationAdapter(record: string): EngineAdapter {
    return {
      ...mockAdapter({ MOCK_RECORD_NEW_FILE: record }),
      creationConfig: {
        reasoning: {
          meta: ['claudeCode', 'options', 'maxThinkingTokens'],
          values: { low: 4000, high: 32000 },
        },
      },
    };
  }

  /**
   * Every session/new the fixture recorded.
   * @param record - the recorder file.
   * @returns parsed params, in order.
   */
  function creations(record: string): { _meta?: Record<string, unknown> }[] {
    return readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { _meta?: Record<string, unknown> });
  }

  it('an explicit resume carries what that call asks for, like systemInstructions always has', async () => {
    const record = join(tmp('runskein-cc-'), 'new.jsonl');
    const store = jsonlStore(tmp('runskein-cc-store-'));
    const hub = makeHub(
      {},
      { store, capabilityOverride: { mock: { loadSession: false, session: { resume: false } } } },
      [creationAdapter(record)],
    );
    const seed = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cc-'),
      config: { reasoning: 'high' },
    });
    await seed.prompt('hello');
    await seed.close();

    const restored = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cc-'),
      resume: seed.id,
      config: { reasoning: 'low' },
      systemInstructions: 'BE TERSE',
    });
    expect(restored.resumeTier).toBe('rebuilt');
    const created = creations(record);
    expect(created).toHaveLength(2);
    expect(created[1]?._meta).toMatchObject({
      'runskein.dev/systemInstructions': 'BE TERSE',
      claudeCode: { options: { maxThinkingTokens: 4_000 } },
    });
    await restored.close();
  }, 20_000);

  it('a reactivation that rebuilds sends it without being asked twice', async () => {
    // The case the plumbing exists for. Nobody repeats the config here: the
    // session lets go of its engine on its own and comes back on the rebuilt
    // tier, and a creation-only value it dropped could never be written back.
    const record = join(tmp('runskein-cc-'), 'new.jsonl');
    const clock = new (class {
      private pending: (() => void)[] = [];
      schedule(_ms: number, fire: () => void): () => void {
        this.pending.push(fire);
        return () => {
          this.pending = this.pending.filter((e) => e !== fire);
        };
      }
      fire(): void {
        const due = this.pending;
        this.pending = [];
        for (const entry of due) entry();
      }
    })();
    const hub = makeHub(
      {},
      {
        store: jsonlStore(tmp('runskein-cc-store-')),
        idleClock: clock,
        capabilityOverride: { mock: { loadSession: false, session: { resume: false } } },
        defaults: { sessionIdleTimeoutMs: 10_000, idleTimeoutMs: 1 },
      },
      [creationAdapter(record)],
    );
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cc-'),
      config: { reasoning: 'high' },
      systemInstructions: 'BE TERSE',
    });
    await s.prompt('hello');
    clock.fire();
    await expectEventually(async () => (await hub.health())['mock'] === 'stopped', 3_000);

    await s.prompt('and again');
    const created = creations(record);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created.at(-1)?._meta).toMatchObject({
      'runskein.dev/systemInstructions': 'BE TERSE',
      claudeCode: { options: { maxThinkingTokens: 32_000 } },
    });
    await s.close();
  }, 20_000);
});
