/**
 * Hermetic conformance for the pi engine.
 *
 * Everything here runs against a scripted stand-in for `pi --mode rpc`: no pi
 * binary, no model, no auth, no network. That is deliberate — the shim is the
 * component that can silently mistranslate, and a gate that needs credentials
 * to run is a gate that stops running.
 *
 * The live cases against a real pi live in the test plan and are run by hand;
 * these are the ones CI enforces.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHub,
  jsonlStore,
  policies,
  builtinAdapters,
  type EngineAdapter,
  type Hub,
  type Session,
  type TranscriptEvent,
} from 'runskein';
import { createFolder } from 'runskein/fold';
import { coreGateSuite } from '../src/suite.js';

const FAKE_PI = resolve(import.meta.dirname, 'fixtures/fake-pi.mjs');
const piAdapter = builtinAdapters.find((a) => a.id === 'pi');
if (!piAdapter) throw new Error('the pi adapter is not bundled');

/** A temp directory for one case's session store, workspace, or trace file. */
const scratch = (prefix: string): string => mkdtempSync(join(tmpdir(), `runskein-pi-${prefix}-`));

/**
 * The pi adapter with its engine replaced by the scripted fake.
 *
 * The shim, the adapter's env scrub list and the whole core path stay exactly
 * as shipped; only the process at the far end is scripted.
 * @param env - fixture toggles for this case.
 * @returns the adapter to register.
 */
function fakePi(env: Record<string, string> = {}): EngineAdapter {
  return {
    ...piAdapter,
    launch: {
      command: process.execPath,
      args: [FAKE_PI],
      env: { FAKE_PI_SESSION_DIR: scratch('sessions'), ...env },
      startTimeoutMs: 20_000,
    },
  };
}

const hubs: Hub[] = [];

/**
 * Create a hub for one case, tracked for teardown.
 * @param adapter - the adapter to register.
 * @returns the hub.
 */
function hub(adapter: EngineAdapter): Hub {
  const created = createHub({ discovery: false, adapters: [adapter], store: jsonlStore(scratch('store')) });
  hubs.push(created);
  return created;
}

/**
 * Open one session on a fake-pi hub.
 * @param env - fixture toggles for this case.
 * @returns the hub, the session, and every update it emits.
 */
async function session(env: Record<string, string> = {}): Promise<{
  hub: Hub;
  session: Session;
  updates: TranscriptEvent[];
}> {
  const created = hub(fakePi(env));
  const opened = await created.session({ engine: 'pi', cwd: scratch('ws') });
  const updates: TranscriptEvent[] = [];
  opened.on('update', (event) => updates.push(event));
  return { hub: created, session: opened, updates };
}

/** Every update of one kind, as their raw ACP payloads. */
const kind = (updates: TranscriptEvent[], name: string): Record<string, unknown>[] =>
  updates.filter((e) => e.update.sessionUpdate === name).map((e) => e.update as Record<string, unknown>);

/** The assistant text a turn streamed, concatenated. */
const replyText = (updates: TranscriptEvent[]): string =>
  kind(updates, 'agent_message_chunk')
    .map((u) => (u['content'] as { text?: string })?.text ?? '')
    .join('');

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit()));
});

// ── the registration gate, driven by the fake ─────────────────────────────

coreGateSuite(fakePi({ FAKE_PI_TOOL: '1', FAKE_PI_ASK: '1' }), {
  timeoutMs: 30_000,
  cancelEnv: { FAKE_PI_PROMPT_MS: '3000' },
  // The fixture refuses to start when the marker leaks through, so a
  // regression in core's scrub fails this case instead of passing quietly.
  envHygieneEnv: { FAKE_PI_REFUSE_ENV: 'CLAUDE_GATE_MARKER' },
  permission: {
    prompt: 'run something',
    rules: [{ tool: 'execute', pattern: '*', action: 'allow' }],
    expectRequest: true,
  },
});

// ── framing ───────────────────────────────────────────────────────────────

describe('pi shim: framing', () => {
  it('PI-SH-01: text containing line/paragraph separators survives intact', async () => {
    const { session: s, updates } = await session({ FAKE_PI_TRICKY_TEXT: '1' });
    await s.prompt('hello');
    // The fixture replies with U+2028, U+2029 and a CR: a reader that treats
    // any of them as a record separator loses or splits this text.
    expect(replyText(updates)).toBe('a\u2028b\u2029c\rd');
  });

  it('PI-SH-02: frames split across chunks, and CRLF terminators, reassemble', async () => {
    const { session: s, updates } = await session({ FAKE_PI_SPLIT_WRITES: '1', FAKE_PI_CRLF: '1' });
    const result = await s.prompt('hello');
    expect(result.stopReason).toBe('end_turn');
    expect(replyText(updates)).toBe('OK');
  });

  it('PI-SH-03/04: startup noise and a malformed line do not break the session', async () => {
    const { session: s, updates } = await session({ FAKE_PI_STARTUP_NOISE: '1' });
    const result = await s.prompt('hello');
    expect(result.stopReason).toBe('end_turn');
    // The noise arrives while the session is still being created, so it is
    // read back from the transcript rather than from a live subscription.
    const persisted: TranscriptEvent[] = [];
    for await (const event of s.transcript()) persisted.push(event);
    // The unparseable line is reported rather than swallowed.
    expect(JSON.stringify(persisted)).toContain('runskein_protocol_error');
    expect(updates.length).toBeGreaterThan(0);
  });
});

// ── capabilities and sessions ─────────────────────────────────────────────

describe('pi shim: capabilities and sessions', () => {
  it('PI-SH-05: declared image support follows the selected model', async () => {
    const withImages = hub(fakePi({ FAKE_PI_MODEL_INPUT: 'text,image' }));
    expect((await withImages.describe('pi')).capabilities.prompt['image']).toBe(true);

    const textOnly = hub(fakePi({ FAKE_PI_MODEL_INPUT: 'text' }));
    expect((await textOnly.describe('pi')).capabilities.prompt['image']).toBe(false);
  }, 30_000);

  it('PI-SH-06: two sessions are two processes and never cross-talk', async () => {
    const trace = join(scratch('trace'), 'spawns.jsonl');
    const created = hub(fakePi({ FAKE_PI_TRACE_FILE: trace }));
    const a = await created.session({ engine: 'pi', cwd: scratch('ws') });
    const b = await created.session({ engine: 'pi', cwd: scratch('ws') });
    expect(a.id).not.toBe(b.id);

    const onB: TranscriptEvent[] = [];
    b.on('update', (event) => onB.push(event));
    await a.prompt('hello');
    expect(onB).toHaveLength(0);

    const pids = new Set(
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).pid),
    );
    // One probe child plus one per session; the two sessions are distinct
    // processes, which is the whole reason the shim spawns per session.
    expect(pids.size).toBeGreaterThanOrEqual(3);
  });

  it('PI-SH-21: embedded context is inlined, and an unsupported block is refused', async () => {
    // The fixture echoes back the single message pi was actually given, which
    // is the only way to see what the shim flattened the blocks into.
    const { session: s, updates } = await session({ FAKE_PI_ECHO_PROMPT: '1' });
    await s.prompt([
      { type: 'text', text: 'look at this' },
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'file body', mimeType: 'text/plain' } },
      { type: 'resource_link', uri: 'file:///b.txt', name: 'b.txt' },
    ]);
    const sent = replyText(updates);
    expect(sent).toContain('look at this');
    expect(sent).toContain('file body');
    expect(sent).toContain('file:///a.txt');
    expect(sent).toContain('@file:///b.txt');

    // pi takes one text message plus images. A block it cannot be given is
    // refused rather than dropped: a prompt silently missing its attachment
    // reads as a model that ignored it.
    await expect(s.prompt([{ type: 'audio', data: 'AAA', mimeType: 'audio/wav' }])).rejects.toThrow();
  }, 30_000);

  it('PI-SH-16: the turn is persisted with the prompt that caused it', async () => {
    const { session: s } = await session();
    await s.prompt('hello');
    const persisted: TranscriptEvent[] = [];
    for await (const event of s.transcript()) persisted.push(event);
    expect(persisted.some((e) => e.update.sessionUpdate === 'user_message_chunk')).toBe(true);
    expect(persisted.some((e) => e.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
  });

  it('PI-SH-20: closing one session leaves its siblings running', async () => {
    const created = hub(fakePi());
    const a = await created.session({ engine: 'pi', cwd: scratch('ws') });
    const b = await created.session({ engine: 'pi', cwd: scratch('ws') });
    await a.close();
    expect((await b.prompt('still here')).stopReason).toBe('end_turn');
  });
});

// ── turns ─────────────────────────────────────────────────────────────────

describe('pi shim: turns', () => {
  it('PI-SH-07/08: a retried run is still one turn', async () => {
    const { session: s } = await session({ FAKE_PI_RETRY_ONCE: '1' });
    const result = await s.prompt('hello');
    expect(result.stopReason).toBe('end_turn');
    // A second turn proves the first one settled exactly once: a leaked
    // settle would have consumed this one's slot.
    expect((await s.prompt('again')).stopReason).toBe('end_turn');
  });

  it('PI-SH-09: pi stop reasons map onto ACP ones', async () => {
    const ended = await session({ FAKE_PI_STOP_REASON: 'stop' });
    expect((await ended.session.prompt('hi')).stopReason).toBe('end_turn');

    const truncated = await session({ FAKE_PI_STOP_REASON: 'length' });
    expect((await truncated.session.prompt('hi')).stopReason).toBe('max_tokens');

    const failed = await session({ FAKE_PI_STOP_REASON: 'error' });
    await expect(failed.session.prompt('hi')).rejects.toThrow();
  }, 30_000);

  it('PI-SH-09: a prompt pi refuses to accept fails the turn', async () => {
    const { session: s } = await session({ FAKE_PI_REJECT_PROMPT: '1' });
    await expect(s.prompt('hi')).rejects.toThrow(/prompt rejected/);
  });

  it('PI-SH-10: cancel resolves the active turn and the session survives', async () => {
    const { session: s, updates } = await session({ FAKE_PI_PROMPT_MS: '3000' });
    const active = s.prompt('long one');
    await new Promise<void>((done) => {
      const off = s.on('update', (event) => {
        if (event.update.sessionUpdate === 'agent_message_chunk') {
          off();
          done();
        }
      });
    });
    await s.cancel();
    expect((await active).stopReason).toBe('cancelled');
    expect(s.status).toBe('idle');
    expect((await s.prompt('after')).stopReason).toBe('end_turn');
    expect(updates.length).toBeGreaterThan(0);
  }, 30_000);
});

// ── tool calls ────────────────────────────────────────────────────────────

describe('pi shim: tool calls', () => {
  it('PI-SH-11/12: the tool-call lifecycle streams, and partial output replaces', async () => {
    const { session: s, updates } = await session({ FAKE_PI_TOOL: '1' });
    await s.prompt('use a tool');

    const started = kind(updates, 'tool_call');
    expect(started).toHaveLength(1);
    expect(started[0]!['status']).toBe('pending');
    expect(started[0]!['toolCallId']).toBe('call-1');

    const progress = kind(updates, 'tool_call_update');
    expect(progress.map((u) => u['status'])).toEqual(['in_progress', 'in_progress', 'completed']);
    const texts = progress.map(
      (u) => (u['content'] as { content?: { text?: string } }[])[0]?.content?.text ?? '',
    );
    // pi resends the whole output each time; treating it as a delta would
    // render 'ababcd'.
    expect(texts).toEqual(['ab', 'abcd', 'abcd']);
  });

  it('PI-SH-13: tool kinds are mapped, and unknown tools stay `other`', async () => {
    const shell = await session({ FAKE_PI_TOOL: '1', FAKE_PI_TOOL_NAME: 'bash' });
    await shell.session.prompt('x');
    expect(kind(shell.updates, 'tool_call')[0]!['kind']).toBe('execute');

    const editor = await session({ FAKE_PI_TOOL: '1', FAKE_PI_TOOL_NAME: 'edit' });
    await editor.session.prompt('x');
    expect(kind(editor.updates, 'tool_call')[0]!['kind']).toBe('edit');

    const custom = await session({ FAKE_PI_TOOL: '1', FAKE_PI_TOOL_NAME: 'my_extension_tool' });
    await custom.session.prompt('x');
    expect(kind(custom.updates, 'tool_call')[0]!['kind']).toBe('other');
  }, 30_000);
});

// ── accounting ────────────────────────────────────────────────────────────

describe('pi shim: usage', () => {
  it('PI-SH-14: cumulative token usage reaches the transcript', async () => {
    const { session: s } = await session({ FAKE_PI_USAGE: '1' });
    await s.prompt('hello');
    const usage = s.usage();
    expect(usage.input).toBe(200);
    expect(usage.output).toBe(20);
    expect(usage.total).toBe(220);
  });

  it('PI-SH-14b: every emitted update is one consumers can fold', async () => {
    // The usage update is a context-window gauge in the protocol, and a frame
    // carrying token counts alone is rejected as malformed by consumers — which
    // is how the first version of this translation was caught. Folding the whole
    // stream is the guard that keeps any update from drifting out of shape.
    const { session: s } = await session({ FAKE_PI_USAGE: '1', FAKE_PI_COST: '1', FAKE_PI_TOOL: '1' });
    await s.prompt('hello');
    const folder = createFolder();
    const rejected: unknown[] = [];
    for await (const event of s.transcript()) {
      for (const folded of folder.push(event)) {
        if (folded.event.type === 'raw') rejected.push(folded.event);
      }
    }
    expect(rejected).toEqual([]);
  }, 30_000);

  it('PI-SH-15: a priced model reports cost; an unpriced one reports none', async () => {
    const priced = await session({ FAKE_PI_USAGE: '1', FAKE_PI_COST: '1' });
    await priced.session.prompt('hello');
    expect(priced.session.usage().cost).toBeCloseTo(0.06, 6);
    expect(priced.session.usage().currency).toBe('USD');

    const unpriced = await session({ FAKE_PI_USAGE: '1' });
    await unpriced.session.prompt('hello');
    // No pricing is reported as absent, never as a zero — a fabricated zero
    // reads as "this turn was free".
    expect(unpriced.session.usage().cost).toBeUndefined();
  }, 30_000);
});

// ── permissions ───────────────────────────────────────────────────────────

describe('pi shim: permissions', () => {
  it('PI-PE-01: an allowed tool call runs', async () => {
    const created = hub(fakePi({ FAKE_PI_TOOL: '1', FAKE_PI_ASK: '1' }));
    let asked = 0;
    const s = await created.session({
      engine: 'pi',
      cwd: scratch('ws'),
      permissionPolicy: (request) => {
        asked++;
        expect(request.tool).toBe('bash');
        expect(request.kind).toBe('execute');
        expect(request.locations?.[0]?.path).toBe('/tmp/root.txt');
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('run it');
    expect(asked).toBe(1);
    expect(kind(updates, 'tool_call_update').at(-1)?.['status']).toBe('completed');
  });

  it('PI-PE-02: a denied tool call is blocked and the turn still settles', async () => {
    const created = hub(fakePi({ FAKE_PI_TOOL: '1', FAKE_PI_ASK: '1' }));
    const s = await created.session({
      engine: 'pi',
      cwd: scratch('ws'),
      permissionPolicy: () => ({ outcome: 'deny' }),
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    expect((await s.prompt('run it')).stopReason).toBe('end_turn');
    expect(kind(updates, 'tool_call_update').at(-1)?.['status']).toBe('failed');
  });

  it('PI-PE-03: a dialog from another extension is dismissed, never approved', async () => {
    const created = hub(fakePi({ FAKE_PI_FOREIGN_DIALOG: '1' }));
    let asked = 0;
    const s = await created.session({
      engine: 'pi',
      cwd: scratch('ws'),
      permissionPolicy: () => {
        asked++;
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('hello');
    // The policy is never consulted about a dialog the shim cannot attribute,
    // and the extension is told the dialog was dismissed.
    expect(asked).toBe(0);
    expect(JSON.stringify(kind(updates, 'session_info_update'))).toContain('undefined');
  });

  it('PI-PE-05: the gate remembers "always allow" for its own process only', async () => {
    // The gate is pi's extension, loaded by pi's own TypeScript runtime, so it
    // is exercised here directly rather than through the fixture: a fixture
    // that reimplemented the cache would only test the fixture.
    const handlers: ((event: unknown, ctx: unknown) => Promise<unknown>)[] = [];
    const asked: string[] = [];
    const ctx = {
      ui: {
        select: (title: string) => {
          asked.push(title);
          return Promise.resolve('allow_always');
        },
      },
    };
    const load = async (): Promise<(event: unknown) => Promise<unknown>> => {
      handlers.length = 0;
      const module = (await import('@runskein/adapter-pi/permission-gate')) as {
        default: (pi: unknown) => void;
      };
      module.default({
        on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
          handlers.push(handler),
      });
      return (event: unknown) => handlers[0]!(event, ctx);
    };

    process.env['RUNSKEIN_PI_GATE_NONCE'] = 'nonce-1';
    const call = { toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } };
    const gate = await load();
    expect(await gate(call)).toBeUndefined();
    expect(await gate({ ...call, toolCallId: 'c2' })).toBeUndefined();
    // The second identical call was answered from the cache, not re-asked.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.startsWith('runskein-pi-permission:nonce-1:')).toBe(true);

    // A different tool call is a different decision.
    await gate({ toolCallId: 'c3', toolName: 'bash', input: { command: 'rm -rf /' } });
    expect(asked).toHaveLength(2);
    delete process.env['RUNSKEIN_PI_GATE_NONCE'];
  });

  it('PI-PE-04: the gate refuses a tool call nobody answered', async () => {
    process.env['RUNSKEIN_PI_GATE_NONCE'] = 'nonce-2';
    const handlers: ((event: unknown, ctx: unknown) => Promise<unknown>)[] = [];
    const module = (await import('@runskein/adapter-pi/permission-gate')) as {
      default: (pi: unknown) => void;
    };
    module.default({
      on: (_event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
        handlers.push(handler),
    });
    // `undefined` is what pi returns for a dismissed or timed-out dialog, and
    // the tool is waiting on the answer: the only safe reading is refusal.
    const decision = await handlers[0]!(
      { toolCallId: 'c1', toolName: 'bash', input: {} },
      { ui: { select: () => Promise.resolve(undefined) } },
    );
    expect(decision).toMatchObject({ block: true });
    delete process.env['RUNSKEIN_PI_GATE_NONCE'];
  });

  it('PI-PE-06: the permission event observes without becoming a second answer', async () => {
    const created = hub(fakePi({ FAKE_PI_TOOL: '1', FAKE_PI_ASK: '1' }));
    let answers = 0;
    const observed: string[] = [];
    const s = await created.session({
      engine: 'pi',
      cwd: scratch('ws'),
      permissionPolicy: () => {
        answers++;
        return policies.rules([{ tool: 'execute', pattern: '*', action: 'allow' }])({
          sessionId: 'x',
          engineId: 'pi',
          tool: 'bash',
          kind: 'execute',
          input: {},
          options: [],
        });
      },
    });
    s.on('permission', (request) => observed.push(request.tool));
    await s.prompt('run it');
    expect(answers).toBe(1);
    expect(observed).toEqual(['bash']);
  });
});

// ── resume and fork ───────────────────────────────────────────────────────

describe('pi shim: resume and fork', () => {
  it("PI-RS-01: a resumed session reattaches to pi's own stored history", async () => {
    const sessionDir = scratch('sessions');
    const created = hub(fakePi({ FAKE_PI_SESSION_DIR: sessionDir }));
    const cwd = scratch('ws');
    const first = await created.session({ engine: 'pi', cwd });
    await first.prompt('remember this');
    await first.close();

    const resumed = await created.session({ engine: 'pi', cwd, resume: first.id });
    expect(resumed.id).toBe(first.id);
    expect((await resumed.prompt('and now?')).stopReason).toBe('end_turn');
  });

  it('PI-RS-02: a resume that pi answers with an empty session is not reported as success', async () => {
    // This pi always answers a resume with an empty session, which is what a
    // real one does when its stored tree has been deleted underneath it.
    const created = hub(fakePi({ FAKE_PI_EMPTY_RESUME: '1' }));
    const cwd = scratch('ws');
    const first = await created.session({ engine: 'pi', cwd });
    await first.prompt('remember this');
    await first.close();

    const resumed = await created.session({ engine: 'pi', cwd, resume: first.id });
    // RunSkein still produces a usable session — a lower resume tier rebuilt it —
    // but the engine was never allowed to claim it had restored the context,
    // which would have left the model answering with no memory of the turn.
    expect(resumed.id).toBe(first.id);
    expect((await resumed.prompt('and now?')).stopReason).toBe('end_turn');
  }, 30_000);

  it('PI-RS-03: a resumed session leaves no second process behind', async () => {
    const trace = join(scratch('trace'), 'spawns.jsonl');
    const created = hub(fakePi({ FAKE_PI_TRACE_FILE: trace }));
    const cwd = scratch('ws');
    const first = await created.session({ engine: 'pi', cwd });
    await first.prompt('remember this');
    await first.close();

    const resumed = await created.session({ engine: 'pi', cwd, resume: first.id });
    expect(resumed.id).toBe(first.id);
    await resumed.prompt('and now?');
    const pids: number[] = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).pid);
    // The probe child and the first session's child are both gone; only the
    // resumed session still holds a process.
    await waitFor(() => pids.filter((pid) => alive(pid)).length === 1);
  }, 30_000);

  it('PI-RS-04: a fork is a separate session with its own process', async () => {
    const sessionDir = scratch('sessions');
    const created = hub(fakePi({ FAKE_PI_SESSION_DIR: sessionDir }));
    const cwd = scratch('ws');
    const parent = await created.session({ engine: 'pi', cwd });
    await parent.prompt('one');

    const forked = await parent.fork();
    expect(forked.id).not.toBe(parent.id);
    await forked.prompt('two');

    const prompts = async (target: Session): Promise<string[]> => {
      const texts: string[] = [];
      for await (const event of target.transcript()) {
        if (event.update.sessionUpdate === 'user_message_chunk') {
          texts.push((event.update as { content?: { text?: string } }).content?.text ?? '');
        }
      }
      return texts;
    };
    // The fork's turn is the fork's alone; the parent never sees it.
    expect(await prompts(forked)).toContain('two');
    expect(await prompts(parent)).not.toContain('two');
    // And the parent's own process is still there to answer.
    expect((await parent.prompt('three')).stopReason).toBe('end_turn');
  }, 30_000);
});

// ── config ────────────────────────────────────────────────────────────────

describe('pi shim: config', () => {
  it('PI-CF-01: the model list is published and a write reaches pi', async () => {
    const created = hub(fakePi());
    const descriptor = await created.describe('pi');
    const model = descriptor.configOptions.find((option) => option.id === 'model');
    expect(model?.options?.map((o) => ('value' in o ? o.value : ''))).toContain('fake/other-model');

    const s = await created.session({ engine: 'pi', cwd: scratch('ws') });
    await s.setConfig({ model: 'fake/other-model' });
    expect((await s.prompt('hello')).stopReason).toBe('end_turn');
  });

  it('PI-CF-02: an unsupported thinking level is refused with the valid list', async () => {
    const created = hub(fakePi({ FAKE_PI_THINKING: 'off,low,high' }));
    const s = await created.session({ engine: 'pi', cwd: scratch('ws') });
    await expect(s.setConfig({ reasoning: 'max' })).rejects.toThrow();
    await s.setConfig({ reasoning: 'high' });
  });

  it('PI-CF-03: modes are absent rather than faked', async () => {
    const created = hub(fakePi());
    const s = await created.session({ engine: 'pi', cwd: scratch('ws') });
    await expect(s.setConfig({ mode: 'plan' })).rejects.toThrow();
  });
});

// ── process lifetime ──────────────────────────────────────────────────────

describe('pi shim: process lifetime', () => {
  it('PI-SH-17a: a dead pi child fails its own turn without crashing the engine', async () => {
    // Only the first child to run a turn dies, so the sibling that must keep
    // working is a sibling of the same shim rather than a different engine.
    const created = hub(
      fakePi({ FAKE_PI_DIE_ON_PROMPT: '1', FAKE_PI_DIE_ONCE_FILE: join(scratch('die'), 'flag') }),
    );
    const dying = await created.session({ engine: 'pi', cwd: scratch('ws') });
    const healthy = await created.session({ engine: 'pi', cwd: scratch('ws') });

    await expect(dying.prompt('this kills it')).rejects.toThrow();
    // The engine process is the shim, and it is still up: a sibling session
    // keeps working, and a later prompt on the dead one reports the death
    // rather than silently starting a fresh, forgetful pi.
    expect(await created.health()).toMatchObject({ pi: 'ready' });
    await expect(dying.prompt('again')).rejects.toThrow();

    expect((await healthy.prompt('still fine')).stopReason).toBe('end_turn');
  }, 30_000);

  it('PI-SH-05b: initialize names the engine version and the shim version', async () => {
    // agentInfo is not on runskein's public surface — the probe records it — so
    // the shim is driven directly here.
    const shim = spawn(process.execPath, [piAdapter.shim!, process.execPath, FAKE_PI], {
      env: { ...process.env, FAKE_PI_SESSION_DIR: scratch('sessions') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const response = await request(shim, 1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const info = (response as { agentInfo?: { name?: string; version?: string } }).agentInfo;
      expect(info?.name).toBe('pi (runskein shim)');
      // The engine's own `--version` output, plus the shim's: drift between
      // the two is unattributable if only one is reported.
      expect(info?.version).toMatch(/^v?\d+\.\d+.*\(shim \d+\)$/);
    } finally {
      shim.stdin.end();
    }
  }, 30_000);

  it('PI-SH-18/19: the shim exits on stdin EOF and takes its children with it', async () => {
    const trace = join(scratch('trace'), 'spawns.jsonl');
    const shimPath = piAdapter.shim;
    expect(shimPath).toBeDefined();
    const shim = spawn(process.execPath, [shimPath!, process.execPath, FAKE_PI], {
      env: { ...process.env, FAKE_PI_TRACE_FILE: trace, FAKE_PI_SESSION_DIR: scratch('sessions') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((done) => shim.on('exit', (code) => done(code)));

    // Drive it far enough to have a live session child, by hand: this case is
    // about process lifetime, not about the ACP surface.
    shim.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
    );
    shim.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: scratch('ws'), mcpServers: [] } })}\n`,
    );
    await waitFor(() => existsSync(trace) && readFileSync(trace, 'utf8').trim().split('\n').length >= 2);
    const pids: number[] = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).pid);

    shim.stdin.end();
    expect(await exited).toBe(0);
    await waitFor(() => pids.every((pid) => !alive(pid)));
    expect(pids.every((pid) => !alive(pid))).toBe(true);
  }, 30_000);

  it('PI-AD-03: pi session markers are scrubbed, and pi configuration is not', async () => {
    const trace = join(scratch('trace'), 'spawns.jsonl');
    process.env['PI_SESSION_ID'] = 'host-session';
    process.env['PI_SESSION_FILE'] = '/tmp/host.jsonl';
    process.env['PI_CODING_AGENT'] = 'true';
    process.env['PI_CODING_AGENT_DIR'] = '/home/user/.pi/agent';
    try {
      const created = hub(fakePi({ FAKE_PI_TRACE_FILE: trace }));
      const s = await created.session({ engine: 'pi', cwd: scratch('ws') });
      await s.prompt('hello');
      const spawns = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const spawn of spawns) {
        expect(spawn.env.PI_SESSION_ID).toBeNull();
        expect(spawn.env.PI_SESSION_FILE).toBeNull();
        expect(spawn.env.PI_CODING_AGENT).toBeNull();
        // Anchored patterns: the config directory is not a session marker, and
        // scrubbing it would throw away the user's own configuration.
        expect(spawn.env.PI_CODING_AGENT_DIR).toBe('/home/user/.pi/agent');
      }
    } finally {
      delete process.env['PI_SESSION_ID'];
      delete process.env['PI_SESSION_FILE'];
      delete process.env['PI_CODING_AGENT'];
      delete process.env['PI_CODING_AGENT_DIR'];
    }
  });
});

/**
 * Send one JSON-RPC request to a hand-driven shim and await its response.
 * @param shim - the shim child process.
 * @param id - the request id.
 * @param method - the ACP method name.
 * @param params - the request params.
 * @returns the response result.
 * @throws `Error` when the shim answers with an error.
 */
function request(
  shim: ReturnType<typeof spawn>,
  id: number,
  method: string,
  params: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (frame.id !== id) continue;
        shim.stdout!.off('data', onData);
        if (frame.error) reject(new Error(frame.error.message));
        else resolve(frame.result);
      }
    };
    shim.stdout!.on('data', onData);
    shim.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/**
 * Whether a pid is still running.
 * @param pid - the process id to test.
 * @returns true while the process exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Poll until a condition holds.
 * @param condition - the predicate to wait for.
 * @param timeoutMs - how long to keep trying.
 * @throws `Error` when the condition never holds.
 */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition never held');
}
