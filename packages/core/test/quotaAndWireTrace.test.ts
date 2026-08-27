/**
 * Quota passthrough and the internal wire-trace seam.
 *
 * The two belong together: the passthrough's contract is "verbatim, or absent",
 * and the only honest way to check "verbatim" is against the frame that
 * actually crossed the wire rather than against runskein's own parsed copy — which
 * is what the trace exists to provide.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WireFrame } from '../src/acp/wireTrace.js';
import { toWireFrame } from '../src/acp/wireTrace.js';
import { Hub } from '../src/hub.js';
import { ProcessManager } from '../src/process/manager.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { mockAdapter, makeHub, tmp } from './testkit.js';

/** A hub whose frames are collected, plus the collected array. */
function tracingHub(env: Record<string, string> = {}): { hub: Hub; frames: WireFrame[] } {
  const frames: WireFrame[] = [];
  const hub = makeHub(env, { wireObserver: () => (frame) => frames.push(frame) });
  return { hub, frames };
}

const promptResponses = (frames: WireFrame[]): WireFrame[] => {
  // A prompt response is an inbound frame with no method carrying stopReason.
  return frames.filter(
    (f) =>
      f.direction === 'in' &&
      f.method === undefined &&
      typeof f.result === 'object' &&
      f.result !== null &&
      'stopReason' in (f.result as Record<string, unknown>),
  );
};

describe('TurnResult.quota', () => {
  it('is absent when the engine reports no _meta at all', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    const turn = await s.prompt('hello');
    expect(turn.quota).toBeUndefined();
    expect('quota' in turn).toBe(false);
    await s.close();
  });

  it('is absent when the engine sends an empty _meta — never synthesized', async () => {
    // opencode's measured shape. A reporting engine that reported nothing must
    // not acquire a quota field out of thin air.
    const hub = makeHub({ MOCK_EMPTY_META: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    const turn = await s.prompt('hello');
    expect(turn.quota).toBeUndefined();
    await s.close();
  });

  it('carries the engine payload verbatim, under the reporting engine id', async () => {
    // codex's measured shape, copied from the ST-QUOTA-01 survey so the
    // hermetic fixture stays anchored to what an engine really sends.
    const payload = {
      token_count: {
        totalTokens: 18438,
        inputTokens: 7425,
        cachedInputTokens: 11008,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      model_usage: [{ model: 'gpt-5.6-sol', token_count: { totalTokens: 18438 } }],
    };
    const { hub, frames } = tracingHub({ MOCK_QUOTA_JSON: JSON.stringify(payload) });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    const turn = await s.prompt('hello');

    expect(turn.quota).toEqual({ engineId: 'mock', payload });

    // The oracle: what crossed the wire, not what runskein stored.
    const [response] = promptResponses(frames);
    const onWire = (response!.result as { _meta: { quota: unknown } })._meta.quota;
    expect(turn.quota!.payload).toEqual(onWire);
    await s.close();
  });

  it('passes a nullish report through instead of treating it as absent', async () => {
    // The engine did report; runskein must not decide on its behalf that it did not.
    const { hub } = tracingHub({ MOCK_QUOTA_JSON: 'null' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    const turn = await s.prompt('hello');
    expect(turn.quota).toEqual({ engineId: 'mock', payload: null });
    await s.close();
  });

  it('is never back-filled from usage accounting', async () => {
    // usage_update is context-window and cost accounting runskein already owns;
    // presenting it as quota would be a confidently wrong budget signal.
    const hub = makeHub({ MOCK_EMIT_USAGE: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-quota-') });
    const turn = await s.prompt('hello');

    const kinds: string[] = [];
    for await (const e of s.transcript()) kinds.push(e.update.sessionUpdate);
    expect(kinds).toContain('usage_update'); // the engine really did report usage
    expect(s.usage().cost).toBeDefined(); // and runskein really did account for it
    expect(turn.quota).toBeUndefined(); // yet quota stays absent
    await s.close();
  });
});

describe('wire trace seam', () => {
  it('observes both directions of a real exchange', async () => {
    const { hub, frames } = tracingHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-wire-') });
    await s.prompt('hello');
    await s.close();

    const out = frames.filter((f) => f.direction === 'out');
    const inbound = frames.filter((f) => f.direction === 'in');
    expect(out.some((f) => f.method === 'initialize')).toBe(true);
    expect(out.some((f) => f.method === 'session/new')).toBe(true);
    expect(out.some((f) => f.method === 'session/prompt')).toBe(true);
    expect(inbound.length).toBeGreaterThan(0);
  });

  it('sees session/update notifications, which never reach the SDK', async () => {
    // The inbound transform consumes updates itself; a trace that missed them
    // would be blind to most of a turn.
    const { hub, frames } = tracingHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-wire-') });
    await s.prompt('hello');
    await s.close();

    const updates = frames.filter((f) => f.direction === 'in' && f.method === 'session/update');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.params).toMatchObject({ sessionId: expect.any(String) });
  });

  it('carries request ids so a response can be matched to its request', async () => {
    const { hub, frames } = tracingHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-wire-') });
    await s.prompt('hello');
    await s.close();

    const request = frames.find((f) => f.direction === 'out' && f.method === 'session/prompt');
    expect(request?.id).toBeDefined();
    const response = frames.find(
      (f) => f.direction === 'in' && f.method === undefined && f.id === request!.id,
    );
    expect(response?.result).toMatchObject({ stopReason: 'end_turn' });
  });

  it('scopes observers per engine through the factory', async () => {
    // The collector lives outside the factory on purpose: the factory runs per
    // connection, so allocating inside it would drop a dead connection's frames
    // on restart.
    const byEngine = new Map<string, WireFrame[]>();
    const hub = new Hub({
      discovery: false,
      adapters: [mockAdapter({}, 'alpha'), mockAdapter({}, 'beta')],
      store: jsonlStore(tmp('runskein-wire-store-')),
      wireObserver: (engineId) => {
        const frames = byEngine.get(engineId) ?? [];
        byEngine.set(engineId, frames);
        return (frame) => frames.push(frame);
      },
    });
    try {
      const a = await hub.session({ engine: 'alpha', cwd: tmp('runskein-wire-') });
      await a.prompt('hello');
      await a.close();

      expect(byEngine.get('alpha')?.length).toBeGreaterThan(0);
      // beta was never acquired, so it never got a connection or a frame.
      expect(byEngine.has('beta')).toBe(false);
    } finally {
      await hub.quit();
    }
  });

  it('the factory runs once per connection, so a restart is traced too', async () => {
    // Pins the documented contract: a harness that allocates inside the factory
    // would drop the dead connection's frames, which is the traffic a crash
    // investigation needs.
    const stateDir = tmp('runskein-wire-crash-');
    const calls: string[] = [];
    const frames: WireFrame[] = [];
    const manager = new ProcessManager({
      wireObserver: (engineId) => {
        calls.push(engineId);
        return (frame) => frames.push(frame);
      },
    });
    try {
      const restarted = new Promise<void>((resolve) => manager.on('engine:restarted', () => resolve()));
      const held = await manager.acquire(
        mockAdapter({
          MOCK_CRASH_AFTER_MS: '100',
          MOCK_CRASH_FLAG_FILE: join(stateDir, 'crashed.flag'),
        }),
        { cwd: tmp('runskein-wire-') },
      );
      await restarted;
      expect(calls).toEqual(['mock', 'mock']); // one per connection, not per engine

      const before = frames.length;
      const fresh = await manager.acquire(mockAdapter());
      await fresh.connection.newSession({ cwd: tmp('runskein-wire-') });
      expect(frames.length).toBeGreaterThan(before); // the new connection is traced
      fresh.release();
      held.release();
    } finally {
      await manager.quit('mock').catch(() => undefined);
    }
  });

  it('an observer that throws degrades tracing only, never the connection', async () => {
    const hub = makeHub(
      {},
      {
        wireObserver: () => () => {
          throw new Error('observer is broken');
        },
      },
    );
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-wire-') });
    const turn = await s.prompt('hello');
    expect(turn.stopReason).toBe('end_turn');
    await s.close();
  });

  it('changes nothing when absent: same transcript with and without an observer', async () => {
    const run = async (traced: boolean): Promise<string[]> => {
      const { hub } = traced ? tracingHub() : { hub: makeHub() };
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-wire-') });
      await s.prompt('hello');
      const kinds: string[] = [];
      for await (const e of s.transcript()) kinds.push(e.update.sessionUpdate);
      await s.close();
      return kinds;
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

describe('toWireFrame', () => {
  it('copies only the fields the message actually carries', () => {
    expect(toWireFrame('out', { jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } })).toEqual({
      direction: 'out',
      id: 1,
      method: 'x',
      params: { a: 1 },
    });
    // A result of null is reported; a missing result is not invented.
    expect(toWireFrame('in', { jsonrpc: '2.0', id: 2, result: null })).toEqual({
      direction: 'in',
      id: 2,
      result: null,
    });
    expect(toWireFrame('in', { jsonrpc: '2.0', id: 3, error: { code: -32601 } })).toEqual({
      direction: 'in',
      id: 3,
      error: { code: -32601 },
    });
  });

  it('rejects anything that is not a JSON-RPC object', () => {
    expect(toWireFrame('in', null)).toBeUndefined();
    expect(toWireFrame('in', [1, 2])).toBeUndefined();
    expect(toWireFrame('in', 'text')).toBeUndefined();
  });
});
