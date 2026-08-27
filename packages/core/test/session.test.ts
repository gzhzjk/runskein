/**
 * Functional tests for Session and Hub over the scripted mock agent: session
 * lifecycle, turn queueing, cancellation, and permissions. Mirrors the live
 * acceptance cases deterministically, without a real engine.
 */
import { describe, expect, it } from 'vitest';
import {
  CancelledError,
  ConfigError,
  EngineCrashError,
  EngineOperationError,
  NotFoundError,
  NotSupportedError,
  StoreError,
} from '../src/errors.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import type { TranscriptStore } from '../src/transcript/store.js';
import type { PermissionRequest } from '../src/permission/policy.js';
import { policies } from '../src/permission/policy.js';
import type { QuestionRequest } from '../src/session/session.js';
import { collect, makeHub, textOf, tmp } from './testkit.js';

describe('Session basics (SL-01…03, SL-08)', () => {
  it('creates, prompts, streams enveloped updates, appears in hub.sessions()', async () => {
    const hub = makeHub();
    const cwd = tmp('runskein-sess-');
    const s = await hub.session({ engine: 'mock', cwd });
    expect(s.engine).toBe('mock');
    expect(s.status).toBe('idle');

    const statuses: string[] = [];
    s.on('status', (st) => statuses.push(st));
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));

    const result = await s.prompt('hello');
    expect(result.stopReason).toBe('end_turn');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Envelope: monotonic seq, epoch-ms ts, provenance.
    expect(updates.length).toBeGreaterThan(0);
    for (const e of updates) {
      expect(e.sessionId).toBe(s.id);
      expect(e.engineId).toBe('mock');
      expect(e.ts).toBeGreaterThan(1_700_000_000_000);
    }
    const seqs = updates.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(updates.some((e) => textOf(e).startsWith('OK'))).toBe(true);

    expect(statuses).toEqual(['running', 'idle']);

    const metas = await hub.sessions();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ sessionId: s.id, engineId: 'mock', cwd, status: 'idle' });

    await s.close();
    expect(s.status).toBe('closed');
    expect((await hub.sessions({ status: 'closed' })).map((m) => m.sessionId)).toEqual([s.id]);
  });

  it('transcript() replays the persisted envelopes, seekable via fromSeq', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await s.prompt('one');
    const all = await collect(s.transcript());
    // creation meta + user chunk + agent chunk at minimum
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all[0]!.update.sessionUpdate).toBe('session_info_update');
    expect(all.some((e) => e.update.sessionUpdate === 'user_message_chunk')).toBe(true);
    const tail = await collect(s.transcript({ fromSeq: all.at(-1)!.seq }));
    expect(tail).toHaveLength(1);
    await s.close();
  });

  it('systemInstructions ride session/new _meta without becoming user content', async () => {
    const hub = makeHub({ MOCK_EXPECT_SYSTEM_INSTRUCTIONS: 'BE TERSE' });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-sess-'),
      systemInstructions: 'BE TERSE',
    });
    await s.prompt('hi');
    await s.prompt('again');
    const userChunks = (await collect(s.transcript()))
      .filter((e) => e.update.sessionUpdate === 'user_message_chunk')
      .map(textOf);
    expect(userChunks).toEqual(['hi', 'again']);
    await s.close();
  });

  it('buffers session updates that arrive before the session/new response', async () => {
    const hub = makeHub({ MOCK_EARLY_UPDATE: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const events = await collect(s.transcript());
    expect(
      events.some(
        (e) => e.update.sessionUpdate === 'session_info_update' && e.update.title === 'early-title',
      ),
    ).toBe(true);
    await s.close();
  });

  it('discards early updates when session/new fails before reusing a native id', async () => {
    const hub = makeHub({ MOCK_FAIL_FIRST_NEW_AFTER_EARLY: '1' });
    await expect(hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') })).rejects.toBeInstanceOf(
      EngineOperationError,
    );
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    expect(
      (await collect(session.transcript())).some(
        (event) =>
          event.update.sessionUpdate === 'session_info_update' &&
          event.update.title === 'failed-early-title',
      ),
    ).toBe(false);
    await session.close();
  });
});

describe('FIFO turn queueing + cancel semantics', () => {
  it('concurrent prompts serialize FIFO', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '80' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const done: string[] = [];
    const p1 = s.prompt('a').then((r) => (done.push('p1'), r));
    const p2 = s.prompt('b').then((r) => (done.push('p2'), r));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(done).toEqual(['p1', 'p2']);
    expect(r1.stopReason).toBe('end_turn');
    expect(r2.stopReason).toBe('end_turn');
    await s.close();
  });

  it('cancel: active resolves stopReason=cancelled, queued rejects, session survives', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '3000' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const firstChunk = new Promise<void>((res) => {
      const un = s.on('update', () => (un(), res()));
    });
    const active = s.prompt('long');
    const queued = s.prompt('queued');
    queued.catch(() => {}); // asserted below
    await firstChunk;
    await s.cancel();
    const result = await active; // the active turn resolves, not rejects
    expect(result.stopReason).toBe('cancelled');
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    expect(s.status).toBe('idle'); // session survives
    const again = await s.prompt('after-cancel');
    expect(again.stopReason).toBe('end_turn');
    await s.close();
  });

  it('close: rejects active AND queued with CancelledError, idempotent', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '3000' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const firstChunk = new Promise<void>((res) => {
      const un = s.on('update', () => (un(), res()));
    });
    const active = s.prompt('long');
    const queued = s.prompt('queued');
    active.catch(() => {});
    queued.catch(() => {});
    await firstChunk;
    await s.close();
    await expect(active).rejects.toBeInstanceOf(CancelledError);
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    expect(s.status).toBe('closed');
    await s.close(); // idempotent
    await expect(s.prompt('nope')).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('Permissions (PE-01…06 analogs)', () => {
  it('default allowAll auto-answers; permission event is read-only observability', async () => {
    const hub = makeHub({ MOCK_ASK_PERMISSION: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const seen: PermissionRequest[] = [];
    s.on('permission', (req) => seen.push(req));
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    await s.prompt('do it');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool: 'write-file', kind: 'edit', engineId: 'mock' });
    const toolDone = updates.find((e) => e.update.sessionUpdate === 'tool_call_update');
    expect(toolDone?.update).toMatchObject({ status: 'completed' }); // allowed
    await s.close();
  });

  it('denyAll: tool call denied via the policy path', async () => {
    const hub = makeHub({ MOCK_ASK_PERMISSION: '1' });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-sess-'),
      permissionPolicy: policies.denyAll,
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    await s.prompt('do it');
    const toolDone = updates.find((e) => e.update.sessionUpdate === 'tool_call_update');
    expect(toolDone?.update).toMatchObject({ status: 'failed' });
    await s.close();
  });

  it('rules policy matches on kind + location pattern', async () => {
    const hub = makeHub({ MOCK_ASK_PERMISSION: '1' });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-sess-'),
      permissionPolicy: policies.rules([{ tool: 'edit', pattern: '*root.txt', action: 'deny' }]),
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    await s.prompt('do it');
    expect(updates.find((e) => e.update.sessionUpdate === 'tool_call_update')?.update).toMatchObject({
      status: 'failed',
    });
    await s.close();
  });
});

describe('Questions / HITL', () => {
  it('question event + respond() completes the elicitation round trip', async () => {
    const hub = makeHub({ MOCK_ASK_QUESTION: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    const statuses: string[] = [];
    s.on('status', (st) => statuses.push(st));
    s.on('question', (q: QuestionRequest) => {
      expect(q.question).toBe('Which flavor?');
      expect(q.options).toEqual([
        { id: 'vanilla', label: 'vanilla' },
        { id: 'chocolate', label: 'chocolate' },
      ]);
      void s.respond(q.requestId, { optionId: 'vanilla' });
    });
    await s.prompt('ask me');
    expect(updates.map(textOf)).toContain('answer:vanilla');
    expect(statuses).toContain('awaiting-input');
    await s.close();
  });

  it('no question listener → declined, prompt still completes', async () => {
    const hub = makeHub({ MOCK_ASK_QUESTION: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    const r = await s.prompt('ask me');
    expect(r.stopReason).toBe('end_turn');
    expect(updates.map(textOf)).toContain('answer:(decline)');
    await s.close();
  });

  it('respond() with an unknown requestId throws', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await expect(s.respond('nope', { text: 'x' })).rejects.toThrow(/no pending question/);
    await s.close();
  });
});

describe('Usage accounting (D7)', () => {
  it('usage_update cost folds into usage(); token fields never fabricated', async () => {
    const hub = makeHub({ MOCK_EMIT_USAGE: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const updates: TranscriptEvent[] = [];
    s.on('update', (e) => updates.push(e));
    const r1 = await s.prompt('one');
    // ACP v1 usage_update has no token breakdown: usage stays absent (D7).
    expect(r1.usage).toBeUndefined();
    await s.prompt('two');
    // Cost is cumulative per ACP Cost semantics; the last report wins.
    expect(s.usage()).toEqual({ cost: 0.02, currency: 'USD' });
    expect(updates.some((e) => e.update.sessionUpdate === 'usage_update')).toBe(true);
    await s.close();
  });

  it('no usage reported: TurnResult.usage and usage() token fields stay absent', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const r = await s.prompt('one');
    expect(r.usage).toBeUndefined(); // never fabricated
    expect(s.usage()).toEqual({});
    await s.close();
  });
});

describe('Negotiated: fork + setConfig (SL-11 analog)', () => {
  it('fork creates an independent session with its own transcript', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await s.prompt('parent turn');
    const forked = await s.fork();
    expect(forked.id).not.toBe(s.id);
    await forked.prompt('child turn');
    const parentEvents = await collect(s.transcript());
    const childEvents = await collect(forked.transcript());
    expect(childEvents.every((e) => e.sessionId === forked.id)).toBe(true);
    expect(parentEvents.length).toBeGreaterThan(0);
    expect((await hub.sessions()).map((m) => m.sessionId).sort()).toEqual([s.id, forked.id].sort());
    await forked.close();
    await s.close();
  });

  it('fork without the capability is NotSupportedError', async () => {
    const hub = makeHub({ MOCK_NO_FORK: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await expect(s.fork()).rejects.toBeInstanceOf(NotSupportedError);
    await s.close();
  });

  // setConfig validation lives in setConfig.test.ts, which asserts the same
  // paths plus the unknown-key, valid-values and no-modes cases.
});

describe('Crash mid-turn + attach + transcripts facade', () => {
  it('mid-turn crash rejects the prompt with EngineCrashError{lastSeq}', async () => {
    const hub = makeHub({ MOCK_CRASH_AFTER_MS: '250', MOCK_PROMPT_DELAY_MS: '5000' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const err = await s.prompt('doomed').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineCrashError);
    expect((err as EngineCrashError).lastSeq).toBeGreaterThan(0);
    expect((err as EngineCrashError).sessionId).toBe(s.id);
    expect(s.status).toBe('failed');
    expect((await hub.sessions({ status: 'failed' })).map((m) => m.sessionId)).toEqual([s.id]);
  });

  it('attach: live returns the same session; unknown id is NotFoundError; stored-only is detached', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    expect(await hub.attach(s.id)).toBe(s);
    await expect(hub.attach('does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
    await s.close();
    const detached = await hub.attach(s.id);
    expect(detached.id).toBe(s.id);
    expect(detached.status).toBe('closed');
  });

  it('hub.transcripts.get/export/digest work store-backed', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await s.prompt('hello');
    await s.close();
    const events = await collect(hub.transcripts.get(s.id));
    expect(events.length).toBeGreaterThan(2);
    const jsonl = await hub.transcripts.export(s.id, 'jsonl');
    expect(jsonl.split('\n')).toHaveLength(events.length);
    const md = await hub.transcripts.export(s.id, 'markdown');
    expect(md).toContain('## Assistant');
    expect(md).toContain('OK');
    const digest = await hub.transcripts.digest(s.id);
    expect(digest.text).toContain('hello');
  });
});

describe('Typed failure boundaries (TR-12 / ER-09 / ER-10)', () => {
  it('advertised session/close failure surfaces after local cleanup', async () => {
    const hub = makeHub({ MOCK_CLOSE_ERROR: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const error = await s.close().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/close', engineId: 'mock', sessionId: s.id });
    expect(s.status).toBe('closed');
  });

  it('hub.quit propagates close failures but still kills the process', async () => {
    const hub = makeHub({ MOCK_CLOSE_ERROR: '1' });
    await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    await expect(hub.quit('mock')).rejects.toMatchObject({ operation: 'session/close' });
    expect(await hub.health()).toMatchObject({ mock: 'dead' });
  });

  it('initial append failure rejects session creation with StoreError', async () => {
    const sentinel = new Error('append sentinel');
    const hub = makeHub({}, { store: throwingStore('append', sentinel) });
    const error = await hub
      .session({ engine: 'mock', cwd: tmp('runskein-sess-') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ operation: 'append', cause: sentinel });
  });

  it('fork waits for its own initial transcript append', async () => {
    const sentinel = new Error('fork append sentinel');
    const hub = makeHub({}, { store: failNthAppendStore(2, sentinel) });
    const parent = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const error = await parent.fork().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ operation: 'append', cause: sentinel });
    await parent.close();
  });

  it('fork buffers updates that arrive before session/fork responds', async () => {
    const hub = makeHub({ MOCK_EARLY_FORK_UPDATE: '1' });
    const parent = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const child = await parent.fork();
    expect(
      (await collect(child.transcript())).some(
        (event) =>
          event.update.sessionUpdate === 'session_info_update' && event.update.title === 'early-fork-title',
      ),
    ).toBe(true);
    await child.close();
    await parent.close();
  });

  it('close preserves store typing when wire close and append both fail', async () => {
    const sentinel = new Error('close append sentinel');
    const hub = makeHub({ MOCK_CLOSE_ERROR: '1' }, { store: failNthAppendStore(2, sentinel) });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const error = await session.close().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ operation: 'append' });
    expect((error as StoreError).cause).toBeInstanceOf(AggregateError);
  });

  it('prompt failure path prioritizes a typed transcript append failure', async () => {
    const sentinel = new Error('turn append sentinel');
    const hub = makeHub({}, { store: failNthAppendStore(2, sentinel) });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-sess-') });
    const error = await session.prompt('hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ operation: 'append' });
    expect((error as StoreError).cause).toBe(sentinel);
    await session.close();
  });

  it.each(['read', 'sessions', 'digest', 'export'] as const)(
    'wraps a custom store %s failure with the matching operation',
    async (operation) => {
      const sentinel = new Error(`${operation} sentinel`);
      const storeOperation = operation === 'export' ? 'read' : operation;
      const hub = makeHub({}, { store: throwingStore(storeOperation, sentinel) });
      let error: unknown;
      if (operation === 'read') {
        error = await collect(hub.transcripts.get('s')).catch((e: unknown) => e);
      } else if (operation === 'sessions') {
        error = await hub.sessions().catch((e: unknown) => e);
      } else if (operation === 'digest') {
        error = await hub.transcripts.digest('s').catch((e: unknown) => e);
      } else {
        error = await hub.transcripts.export('s', 'jsonl').catch((e: unknown) => e);
      }
      expect(error).toBeInstanceOf(StoreError);
      expect(error).toMatchObject({ operation, cause: sentinel });
    },
  );
});

function throwingStore(
  failing: 'append' | 'read' | 'sessions' | 'digest',
  sentinel: Error,
): TranscriptStore {
  const events: TranscriptEvent[] = [];
  return {
    async append(event) {
      if (failing === 'append') throw sentinel;
      events.push(event);
    },
    async *read(sessionId) {
      if (failing === 'read') throw sentinel;
      yield* events.filter((event) => event.sessionId === sessionId);
    },
    async sessions() {
      if (failing === 'sessions') throw sentinel;
      return [];
    },
    async digest(sessionId) {
      if (failing === 'digest') throw sentinel;
      return { sessionId, throughSeq: 0, text: '' };
    },
    async delete() {},
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

// ── Regressions found against live engines ─────────────────────────────────
//
// Three defects the mock never provoked until it was taught to: update
// variants the SDK's closed zod union would reject must still reach the
// consumer, mixed interactive requests must keep their arrival order, and fork
// must send the workspace parameters the schema requires. The live evidence
// lives in conformance/src/live.ts.

describe('Update variants core has never seen (regression: found live)', () => {
  it('is delivered to the consumer and the turn completes', async () => {
    const hub = makeHub({ MOCK_UNKNOWN_UPDATE: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-i1-') });
    const events: TranscriptEvent[] = [];
    s.on('update', (e) => events.push(e));
    const r = await s.prompt('go');
    expect(
      events.some(
        (e) => (e.update as unknown as { sessionUpdate: string }).sessionUpdate === 'totally_unknown_kind',
      ),
    ).toBe(true);
    expect(
      events.some((e) => {
        const update = e.update as unknown as { content?: { type?: string }[] };
        return (
          Array.isArray(update.content) &&
          update.content.some((content) => content.type === 'future_content')
        );
      }),
    ).toBe(true);
    expect(r.stopReason).toBe('end_turn');
    await s.close();
  });
});

describe('Fork carries the parent workspace (regression: found live)', () => {
  it('succeeds against a fixture that rejects a missing or non-absolute cwd', async () => {
    const hub = makeHub();
    const cwd = tmp('runskein-i3-');
    const parent = await hub.session({ engine: 'mock', cwd });
    const forked = await parent.fork();
    expect(forked.cwd).toBe(cwd);
    await forked.close();
    await parent.close();
  });
});

describe('Interactive request ordering (regression: found live)', () => {
  it('preserves question-before-permission wire order', async () => {
    const hub = makeHub({ MOCK_Q_THEN_P: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-i2-') });
    const seen: string[] = [];
    s.on('question', (q) => {
      seen.push('question');
      void s.respond(q.requestId, { optionId: 'vanilla' });
    });
    s.on('permission', (p: PermissionRequest) => seen.push(`permission:${p.tool}`));
    const r = await s.prompt('go');
    expect(r.stopReason).toBe('end_turn');
    expect(seen).toEqual(['question', 'permission:write-file']);
    await s.close();
  });
});
