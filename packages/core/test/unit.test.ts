/**
 * Unit tests — the pieces that need no process: env scrub, the health state
 * machine, capability normalization and the mask-only capabilityOverride seam,
 * plus TurnQueue ordering, permission policies, usage folding, and session
 * metadata riding the transcript.
 */
import { describe, expect, it } from 'vitest';
import { mergeEnv, scrubEnv, ENV_SCRUB_PATTERNS } from '../src/process/spawn.js';
import { HealthMachine } from '../src/process/health.js';
import { applyCapabilityOverride, normalizeCapabilities } from '../src/acp/capabilities.js';
import { ConfigError } from '../src/errors.js';
import { TurnQueue } from '../src/session/turnQueue.js';
import { decisionToOutcome, policies } from '../src/permission/policy.js';
import type { PermissionRequest } from '../src/permission/policy.js';
import { foldUsage, readCost, readSessionMeta, sessionMetaUpdate } from '../src/transcript/event.js';
import { foldSessionMeta, matchesFilter } from '../src/transcript/store.js';
import type { TranscriptEvent } from '../src/transcript/event.js';

describe('process environment hygiene', () => {
  // A stand-in host environment, written with an invented engine's markers
  // rather than a real one's: which patterns a bundled adapter declares is
  // that adapter's business, pinned in the runskein meta-package's tests. What
  // is proved here is the mechanism, which must behave the same for an engine
  // this repository has never seen.
  const dirty = {
    PATH: '/usr/bin',
    DEMOAGENT_SESSION_ID: 'abc',
    DEMOAGENT: '1',
    DEMOAGENT_CONFIG: 'keep-me', // not a session marker
    HOME: '/home/u',
  };

  it('scrubs nothing of its own: every marker is an adapter declaration', () => {
    // The core list is empty on purpose (decision 045). A host variable
    // survives unless the adapter being spawned asked for it to go, so this
    // case fails the moment an engine name is written back into core.
    expect(scrubEnv(dirty)).toEqual(dirty);
  });

  it('drops the markers the adapter declares, keeps the rest', () => {
    const clean = scrubEnv(dirty, [/^DEMOAGENT/]);
    expect(Object.keys(clean).sort()).toEqual(['HOME', 'PATH']);
  });

  it('honours an adapter pattern anchored narrowly enough to spare configuration', () => {
    const clean = scrubEnv(dirty, [/^DEMOAGENT(_SESSION)?$/]);
    expect(clean).not.toHaveProperty('DEMOAGENT');
    expect(clean).toHaveProperty('DEMOAGENT_CONFIG');
    expect(clean).toHaveProperty('PATH');
  });

  it('treats stateful adapter regexes deterministically for every key', () => {
    expect(scrubEnv({ SECRET_A: 'a', SECRET_B: 'b', KEEP: 'x' }, [/^SECRET_/g])).toEqual({
      KEEP: 'x',
    });
  });

  it('recognises a session marker whatever case the host spells it in', () => {
    // Windows resolves variable names without case, so a marker spelled
    // `Demoagent` there is the marker the scrub exists to remove, and an
    // engine handed it back refuses to start with "active session".
    expect(scrubEnv({ Demoagent: '1', KEEP: 'x' }, [/^DEMOAGENT/])).toEqual({ KEEP: 'x' });
    // The adapter's pattern is read the same way round: its author's case is
    // preserved rather than the name being folded to match it.
    expect(scrubEnv({ Pi_Session_Id: 's', KEEP: 'x' }, [/^pi_session_/])).toEqual({ KEEP: 'x' });
  });

  it('lets an override displace the host variable the host would resolve it to', () => {
    // The caseless side is the one this Darwin runner never reaches by default,
    // so both are driven directly: a Windows child handed `MY_FLAG` and
    // `my_flag` receives one of them, and which one is not something the policy
    // could have read.
    expect(mergeEnv({ MY_FLAG: 'host' }, [{ name: 'my_flag', value: 'agent' }], true)).toEqual({
      my_flag: 'agent',
    });
    // On POSIX they are two variables, and the host's own is not the agent's
    // to remove.
    expect(mergeEnv({ MY_FLAG: 'host' }, [{ name: 'my_flag', value: 'agent' }], false)).toEqual({
      MY_FLAG: 'host',
      my_flag: 'agent',
    });
    // The ordinary case on both: the override replaces the host's value.
    expect(mergeEnv({ MY_FLAG: 'host' }, [{ name: 'MY_FLAG', value: 'agent' }], false)).toEqual({
      MY_FLAG: 'agent',
    });
    // A variable named `__proto__` is a variable, not a key into our own
    // object: assigning it on a plain object runs a setter and the child would
    // never receive what the policy approved.
    const proto = mergeEnv({}, [{ name: '__proto__', value: 'agent' }], false);
    expect(Object.prototype.hasOwnProperty.call(proto, '__proto__')).toBe(true);
    expect(proto['__proto__']).toBe('agent');
  });

  it('drops undefined values', () => {
    expect(scrubEnv({ A: undefined, B: 'x' })).toEqual({ B: 'x' });
  });

  it('core declares no engine of its own', () => {
    // Decision 045: an engine's markers belong to its adapter. Core keeps the
    // list only for a marker no single engine owns, and there is none today.
    expect(ENV_SCRUB_PATTERNS).toEqual([]);
  });
});

describe('HealthMachine', () => {
  it('walks the happy path stopped → starting → ready → stopped', () => {
    const h = new HealthMachine();
    expect(h.state).toBe('stopped');
    h.to('starting');
    h.to('ready');
    expect(h.live).toBe(true);
    h.to('stopped'); // idle reap
    expect(h.state).toBe('stopped');
    expect(h.live).toBe(false);
  });

  it('crash path ready → degraded → ready (restart)', () => {
    const h = new HealthMachine();
    h.to('starting');
    h.to('ready');
    h.to('degraded');
    expect(h.live).toBe(true);
    h.to('ready');
  });

  it('budget exhausted: degraded → dead, then dead → starting respawns', () => {
    const h = new HealthMachine();
    h.to('starting');
    h.to('ready');
    h.to('degraded');
    h.to('dead');
    expect(h.live).toBe(false);
    h.to('starting'); // next session()
  });

  it('rejects illegal transitions', () => {
    const h = new HealthMachine();
    expect(() => h.to('ready')).toThrow(/illegal health transition/);
    h.to('starting');
    h.to('ready');
    h.to('stopped');
    expect(() => h.to('degraded')).toThrow(/illegal health transition/);
  });

  it('same-state transition is a no-op', () => {
    const h = new HealthMachine();
    expect(() => h.to('stopped')).not.toThrow();
  });
});

describe('normalizeCapabilities', () => {
  it('normalizes measured initialize shapes to booleans', () => {
    const m = normalizeCapabilities({
      loadSession: true,
      sessionCapabilities: { resume: true, list: true, close: undefined, fork: 0 },
      promptCapabilities: { image: true, audio: false },
      mcpCapabilities: { http: true, sse: false },
      providers: { list: true },
    });
    expect(m).toEqual({
      loadSession: true,
      session: { resume: true, list: true, close: false, fork: false },
      prompt: { image: true, audio: false },
      mcp: { http: true, sse: false },
      providers: true,
    });
  });

  it('handles a missing capabilities object', () => {
    expect(normalizeCapabilities(undefined)).toEqual({
      loadSession: false,
      session: {},
      prompt: {},
      mcp: {},
      providers: false,
    });
  });
});

describe('applyCapabilityOverride (mask only)', () => {
  const measured = normalizeCapabilities({
    loadSession: true,
    sessionCapabilities: { resume: true, close: true },
    promptCapabilities: { image: true },
    mcpCapabilities: { http: true },
    providers: false,
  });

  it('masks capability bits off', () => {
    const masked = applyCapabilityOverride('mock', measured, {
      loadSession: false,
      session: { resume: false },
    });
    expect(masked.loadSession).toBe(false);
    expect(masked.session).toEqual({ resume: false, close: true });
    expect(masked.prompt).toEqual({ image: true });
  });

  it('refuses to widen with a ConfigError', () => {
    expect(() => applyCapabilityOverride('mock', measured, { session: { fork: true } })).toThrow(
      ConfigError,
    );
    expect(() => applyCapabilityOverride('mock', measured, { providers: true })).toThrow(ConfigError);
  });

  it('no override = same matrix', () => {
    expect(applyCapabilityOverride('mock', measured, undefined)).toBe(measured);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('TurnQueue', () => {
  it('runs turns strictly FIFO, one at a time', async () => {
    const q = new TurnQueue<string>();
    const order: string[] = [];
    const slow = q.enqueue(async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
      return 'a';
    });
    const fast = q.enqueue(async () => {
      order.push('b:start');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']); // no interleaving
  });

  it('rejectQueued rejects only turns that never ran', async () => {
    const q = new TurnQueue<string>();
    let resolveActive!: () => void;
    const active = q.enqueue(() => new Promise<string>((res) => (resolveActive = () => res('done'))));
    const queued = q.enqueue(async () => 'never');
    await tick();
    expect(q.isActive).toBe(true);
    expect(q.rejectQueued(() => new Error('cancelled-queued'))).toBe(1);
    await expect(queued).rejects.toThrow('cancelled-queued');
    resolveActive();
    await expect(active).resolves.toBe('done'); // active turn untouched
  });

  it('rejectActive rejects the consumer promise; the run keeps executing', async () => {
    const q = new TurnQueue<string>();
    let finished = false;
    const active = q.enqueue(async () => {
      await tick();
      finished = true;
      return 'ignored';
    });
    await Promise.resolve();
    expect(q.rejectActive(new Error('closed'))).toBe(true);
    await expect(active).rejects.toThrow('closed');
    await tick();
    expect(finished).toBe(true); // discarded, not interrupted
  });
});

describe('permission policies', () => {
  const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
    sessionId: 's',
    engineId: 'e',
    tool: 'write-file',
    kind: 'edit',
    input: { path: '/w/root.txt' },
    locations: [{ path: '/w/root.txt' }],
    options: [
      { optionId: 'y', name: 'Yes', kind: 'allow_once' },
      { optionId: 'n', name: 'No', kind: 'reject_once' },
    ],
    ...over,
  });

  it('allowAll / denyAll', async () => {
    expect(await policies.allowAll(req())).toEqual({ outcome: 'allow' });
    expect(await policies.denyAll(req())).toEqual({ outcome: 'deny' });
  });

  it('rules: first match wins, kind or tool name matches, glob patterns', async () => {
    const policy = policies.rules([
      { tool: 'execute', pattern: 'sub/*', action: 'allow' },
      { tool: 'edit', pattern: '*root.txt', action: 'deny' },
      { tool: '*', pattern: '*', action: 'allow' },
    ]);
    expect(await policy(req())).toEqual({ outcome: 'deny' }); // edit + root.txt
    expect(await policy(req({ kind: 'execute', locations: [{ path: 'sub/x.sh' }] }))).toEqual({
      outcome: 'allow',
    });
    expect(await policy(req({ tool: 'other-tool', kind: 'read' }))).toEqual({
      outcome: 'allow',
    }); // wildcard fallthrough
  });

  it('rules: no match fails closed (deny)', async () => {
    const policy = policies.rules([{ tool: 'execute', pattern: '*', action: 'allow' }]);
    expect(await policy(req())).toEqual({ outcome: 'deny' });
  });

  it('decisionToOutcome maps bare outcomes to the closest optionId', () => {
    const options = req().options;
    expect(decisionToOutcome({ outcome: 'allow' }, options)).toEqual({
      outcome: 'selected',
      optionId: 'y',
    });
    expect(decisionToOutcome({ outcome: 'deny' }, options)).toEqual({
      outcome: 'selected',
      optionId: 'n',
    });
    expect(decisionToOutcome({ optionId: 'n' }, options)).toEqual({
      outcome: 'selected',
      optionId: 'n',
    });
    // deny with no reject-kind option → cancelled, never a silent allow
    expect(decisionToOutcome({ outcome: 'deny' }, [{ optionId: 'a', name: 'A' }])).toEqual({
      outcome: 'cancelled',
    });
  });
});

describe('usage folding', () => {
  it('normalizes *Tokens names and keeps absent fields absent', () => {
    const u = foldUsage(undefined, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(u).toEqual({ input: 10, output: 20, total: 30 });
    expect(u!.thought).toBeUndefined();
  });

  it('later reports replace, earlier extras survive', () => {
    const a = foldUsage(undefined, { inputTokens: 1, outputTokens: 2, thoughtTokens: 5 });
    const b = foldUsage(a, { inputTokens: 10, outputTokens: 20 });
    expect(b).toMatchObject({ input: 10, output: 20, thought: 5 });
  });

  it('a {used,size,cost} report has no tokens: prev returned unchanged', () => {
    const raw = { used: 12355, size: 1_000_000, cost: { amount: 0.0015, currency: 'USD' } };
    expect(foldUsage(undefined, raw)).toBeUndefined();
    const prev = foldUsage(undefined, { inputTokens: 1, outputTokens: 2 });
    expect(foldUsage(prev, raw)).toBe(prev);
    expect(readCost(raw)).toEqual({ cost: 0.0015, currency: 'USD' });
    expect(readCost({ used: 5 })).toBeUndefined();
  });
});

describe('session meta on the transcript', () => {
  const ev = (seq: number, update: TranscriptEvent['update'], ts = seq): TranscriptEvent => ({
    seq,
    ts,
    sessionId: 's1',
    engineId: 'mock',
    update,
  });

  it('round-trips through session_info_update._meta', () => {
    const update = sessionMetaUpdate({ cwd: '/w', status: 'idle' });
    expect(update.sessionUpdate).toBe('session_info_update');
    expect(readSessionMeta(update)).toEqual({ cwd: '/w', status: 'idle' });
  });

  it('foldSessionMeta derives SessionMeta from an event stream', () => {
    const meta = foldSessionMeta([
      ev(1, sessionMetaUpdate({ cwd: '/w', status: 'idle' }), 100),
      ev(2, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }, 150),
      ev(3, sessionMetaUpdate({ status: 'closed' }), 200),
    ]);
    expect(meta).toEqual({
      sessionId: 's1',
      engineId: 'mock',
      cwd: '/w',
      status: 'closed',
      createdAt: 100,
      updatedAt: 200,
    });
    expect(matchesFilter(meta!, { engineId: 'mock', status: 'closed' })).toBe(true);
    expect(matchesFilter(meta!, { since: 250 })).toBe(false);
  });
});
