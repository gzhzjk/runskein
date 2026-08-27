/**
 * Regressions: defects found by review rather than by a milestone, each case
 * pinning the exact behaviour that was missing — resume rejecting an unknown id
 * before spawning, MCP transports never silently ignored, and gaps in the
 * usage, config, and store contracts.
 *
 * Test-plan cases: RS-04, RS-08, ER-07, SL-13.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, type InternalHubOptions } from '../src/hub.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { sqliteStore } from '../src/transcript/sqliteStore.js';
import { recoverAccounting } from '../src/session/resume.js';
import { ConfigError, NotFoundError, NotSupportedError, StoreError } from '../src/errors.js';
import type { TranscriptStore } from '../src/transcript/store.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import { mockAdapter, tmp } from './testkit.js';

// Hub construction and cleanup stay local here, unlike the other suites: these
// cases deliberately hand hubs a store that fails, and such a hub can reject on
// quit. The shared helper lets a failing quit fail the run, which is right when
// a leak is a bug; here it is the behaviour under test.
const hubs: Hub[] = [];
function makeHub(store: TranscriptStore, env: Record<string, string> = {}, extra: InternalHubOptions = {}) {
  const hub = new Hub({ discovery: false, adapters: [mockAdapter(env)], store, ...extra });
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit().catch(() => {})));
});

const REBUILD_MASK = { mock: { loadSession: false, session: { resume: false } } };

describe('1 — unknown resume id fails before any spawn, as resource=session', () => {
  it('rejects NotFoundError{resource:session} and never starts the engine', async () => {
    const hub = makeHub(jsonlStore(tmp('runskein-rf-')));
    const err = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: 'no-such-id' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ resource: 'session', resourceId: 'no-such-id' });
    // The store lookup failed BEFORE manager.acquire: no process was spawned.
    expect((await hub.health())['mock']).toBe('stopped');
  });

  it('wraps raw custom-store read failures before spawn, including provenance', async () => {
    const backing = jsonlStore(tmp('runskein-rf-'));
    const store: TranscriptStore = {
      ...backing,
      async *read() {
        throw new Error('raw read failure');
      },
    };
    const hub = makeHub(store);
    const err = await hub
      .session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: 'stored-id' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({
      operation: 'read',
      engineId: 'mock',
      sessionId: 'stored-id',
    });
    expect((await hub.health())['mock']).toBe('stopped');

    const attachError = await hub.attach('stored-id').catch((e: unknown) => e);
    expect(attachError).toBeInstanceOf(StoreError);
    expect(attachError).toMatchObject({ operation: 'read', sessionId: 'stored-id' });
  });

  it('maps a raw tier-3 digest failure to StoreError{operation:digest}', async () => {
    const backing = jsonlStore(tmp('runskein-rf-store-'));
    const seedHub = makeHub(backing);
    const seed = await seedHub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await seed.close();
    await seedHub.quit();

    const failingDigest: TranscriptStore = {
      ...backing,
      async digest() {
        throw new Error('raw digest failure');
      },
    };
    const resumeHub = makeHub(failingDigest, {}, { capabilityOverride: REBUILD_MASK });
    const err = await resumeHub
      .session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: seed.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({
      operation: 'digest',
      engineId: 'mock',
      sessionId: seed.id,
    });
  });
});

describe('2 — tier-3 rebuild carries systemInstructions', () => {
  it('the fresh session/new receives the _meta instructions (fixture-enforced)', async () => {
    const storeDir = tmp('runskein-rf-store-');
    const seedHub = makeHub(jsonlStore(storeDir));
    const seed = await seedHub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await seed.prompt('remember swordfish');
    await seed.close();
    await seedHub.quit();

    // This hub's fixture REFUSES any session/new whose _meta does not carry
    // exactly these instructions — a passing resume proves they were sent.
    const resumeHub = makeHub(
      jsonlStore(storeDir),
      { MOCK_EXPECT_SYSTEM_INSTRUCTIONS: 'CARRY ME' },
      { capabilityOverride: REBUILD_MASK },
    );
    const r = await resumeHub.session({
      engine: 'mock',
      cwd: tmp('runskein-rf-'),
      resume: seed.id,
      systemInstructions: 'CARRY ME',
    });
    expect(r.resumeTier).toBe('rebuilt');
    await r.close();
  });
});

describe('3 — undeclared MCP transports are NotSupportedError (SL-13)', () => {
  it('sse (not advertised) is refused, naming the capability', async () => {
    const hub = makeHub(jsonlStore(tmp('runskein-rf-')));
    const err = await hub
      .session({
        engine: 'mock',
        cwd: tmp('runskein-rf-'),
        mcpServers: [{ type: 'sse', name: 'x', url: 'http://127.0.0.1:1/sse', headers: [] }],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(NotSupportedError);
    expect((err as NotSupportedError).capability).toBe('mcp:sse');
    // The advertised-http half is plan-negotiated's, which drives a real HTTP
    // server and asserts the tool call reached it — a smoke session here would
    // only repeat the weaker part of that.
  });
});

describe('4 — cumulative usage/cost survive resume and never regress', () => {
  it('remembers a currency conflict even inside one cumulative segment', () => {
    const usageEvent = (seq: number, currency: string): TranscriptEvent => ({
      seq,
      ts: seq,
      sessionId: 's',
      engineId: 'e',
      update: {
        sessionUpdate: 'usage_update',
        used: seq,
        size: 100,
        cost: { amount: seq, currency },
      },
    });
    const accounting = recoverAccounting([usageEvent(1, 'USD'), usageEvent(2, 'EUR')]);
    expect(accounting.mixedCostCurrencies).toBe(true);
  });

  it('rebuilt resume: prior cost is an additive baseline', async () => {
    const store = jsonlStore(tmp('runskein-rf-store-'));
    const hub = makeHub(store, { MOCK_EMIT_USAGE: '1' }, { capabilityOverride: REBUILD_MASK });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await s.prompt('one');
    const seedCost = s.usage().cost!;
    expect(seedCost).toBeGreaterThan(0);
    await s.close();

    const r = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: s.id });
    expect(r.resumeTier).toBe('rebuilt');
    // Cost recovered from the stored transcript, before any new turn.
    expect(r.usage().cost).toBeCloseTo(seedCost, 10);
    await r.prompt('two');
    // The fresh engine session's counter restarted; the combined value must
    // still be strictly greater than the prior life's total — no regression.
    expect(r.usage().cost!).toBeGreaterThan(seedCost);
    await r.close();
  });

  it('a SECOND rebuilt resume still sums every prior life (segmented recovery)', async () => {
    const store = jsonlStore(tmp('runskein-rf-store-'));
    const hub = makeHub(store, { MOCK_EMIT_USAGE: '1' }, { capabilityOverride: REBUILD_MASK });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await s.prompt('one'); // life 1 reports cumulative cost c1
    const life1 = s.usage().cost!;
    await s.close();

    const r1 = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: s.id });
    await r1.prompt('two'); // life 2 reports its own cumulative c2
    const combined1 = r1.usage().cost!;
    expect(combined1).toBeGreaterThan(life1);
    await r1.close();

    const r2 = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: s.id });
    expect(r2.resumeTier).toBe('rebuilt');
    // Recovery must equal life1 + life2, not just the LAST life's counter.
    expect(r2.usage().cost).toBeCloseTo(combined1, 10);
    await r2.close();
  });

  it('native resume AFTER a rebuild keeps pre-rebuild lives as baseline', async () => {
    const storeDir = tmp('runskein-rf-store-');
    const maskedHub = makeHub(
      jsonlStore(storeDir),
      { MOCK_EMIT_USAGE: '1' },
      { capabilityOverride: REBUILD_MASK },
    );
    const s = await maskedHub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await s.prompt('one'); // life 1
    await s.close();
    const r1 = await maskedHub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: s.id });
    await r1.prompt('two'); // life 2 (rebuilt)
    const combined = r1.usage().cost!;
    await r1.close();
    await maskedHub.quit();

    // Unmasked hub: tier-1 native continuation of life 2. Life 1's total
    // must survive as baseline — replace semantics only apply to life 2.
    const nativeHub = makeHub(jsonlStore(storeDir), { MOCK_EMIT_USAGE: '1' });
    const r2 = await nativeHub.session({ engine: 'mock', cwd: tmp('runskein-rf-'), resume: s.id });
    expect(r2.resumeTier).toBe('native');
    expect(r2.usage().cost).toBeCloseTo(combined, 10);
    await r2.close();
  });

  it('detached attach exposes recovered cost', async () => {
    const store = jsonlStore(tmp('runskein-rf-store-'));
    const hub = makeHub(store, { MOCK_EMIT_USAGE: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await s.prompt('one');
    const cost = s.usage().cost!;
    await s.close();
    const a = await hub.attach(s.id);
    expect(a.usage().cost).toBeCloseTo(cost, 10);
  });

  it('cross-engine mixed currencies never fabricate a scalar total', async () => {
    const store = jsonlStore(tmp('runskein-rf-store-'));
    const usdHub = new Hub({
      discovery: false,
      adapters: [mockAdapter({ MOCK_EMIT_USAGE: '1', MOCK_USAGE_CURRENCY: 'USD' }, 'usd')],
      store,
    });
    hubs.push(usdHub);
    const seed = await usdHub.session({ engine: 'usd', cwd: tmp('runskein-rf-') });
    await seed.prompt('one');
    expect(seed.usage()).toMatchObject({ currency: 'USD' });
    await seed.close();
    await usdHub.quit();

    const eurHub = new Hub({
      discovery: false,
      adapters: [mockAdapter({ MOCK_EMIT_USAGE: '1', MOCK_USAGE_CURRENCY: 'EUR' }, 'eur')],
      store,
    });
    hubs.push(eurHub);
    const resumed = await eurHub.session({
      engine: 'eur',
      cwd: tmp('runskein-rf-'),
      resume: seed.id,
    });
    expect(resumed.resumeTier).toBe('rebuilt');
    expect(resumed.usage()).toMatchObject({ currency: 'USD' });
    await resumed.prompt('two');
    expect(resumed.usage()).toEqual({});
    await resumed.close();

    // The conflict is persisted across detached views and later recovery.
    expect((await eurHub.attach(seed.id)).usage()).toEqual({});
  });
});

describe('5 — setConfig is atomic: validation failures write nothing', () => {
  it('a patch with one invalid entry performs zero wire writes', async () => {
    const record = join(tmp('runskein-rf-cfg-'), 'writes.jsonl');
    const hub = makeHub(jsonlStore(tmp('runskein-rf-')), {
      MOCK_MULTI_CONFIG: '1',
      MOCK_RECORD_SET_CONFIG_FILE: record,
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-rf-') });
    await expect(s.setConfig({ model: 'm2', reasoning: 'bogus' })).rejects.toBeInstanceOf(ConfigError);
    // Nothing reached the engine — not even the valid leading entry.
    expect(existsSync(record) ? readFileSync(record, 'utf8').trim() : '').toBe('');
    // The same valid entry applies once the patch as a whole is valid.
    await s.setConfig({ model: 'm2' });
    expect(readFileSync(record, 'utf8')).toContain('"configId":"model"');
    await s.close();
  });
});

describe('6 — sqliteStore failures carry the caller operation', () => {
  it('open failure surfaces as the invoked method, never a hardcoded read', async () => {
    const broken = () => sqliteStore('/nonexistent-runskein-dir/xyz/events.db');
    const cases: [string, () => Promise<unknown>][] = [
      ['sessions', () => broken().sessions()],
      ['digest', () => broken().digest('s1')],
      ['delete', () => broken().delete('s1')],
      [
        'append',
        () =>
          broken().append({
            seq: 1,
            ts: 1,
            sessionId: 's1',
            engineId: 'e',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
          }),
      ],
      [
        'read',
        async () => {
          for await (const _ of broken().read('s1')) void _;
        },
      ],
    ];
    for (const [operation, run] of cases) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, operation).toBeInstanceOf(StoreError);
      expect((err as StoreError).operation, operation).toBe(operation);
    }
  });
});
