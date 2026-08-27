/**
 * Session config state: desired writes versus engine observations.
 *
 * The point under test is the separation — runskein must never present what it
 * asked for as what the engine confirmed — plus the provenance carried on each
 * observation and the guarantee that reading state touches no wire.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpConnection } from '../src/acp/connection.js';
import { NotSupportedError } from '../src/errors.js';
import { makeHub, mockAdapter, tmp } from './testkit.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configState(): desired', () => {
  it('records only acknowledged writes, keyed by the runskein key the caller used', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    expect(s.configState().desired).toEqual({});

    await s.setConfig({ model: 'm2', mode: 'plan' });
    expect(s.configState().desired).toEqual({ model: 'm2', mode: 'plan' });
    await s.close();
  });

  it('config passed at session creation lands in desired', async () => {
    const hub = makeHub();
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cfg-'),
      config: { model: 'm2' },
    });
    expect(s.configState().desired.model).toBe('m2');
    await s.close();
  });

  it('a rejected write leaves desired untouched, and earlier accepted keys survive', async () => {
    // setConfig validates the whole patch first, so an invalid value never
    // reaches the wire; a valid earlier write from a previous call must remain.
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    await s.setConfig({ model: 'm2' });
    await expect(s.setConfig({ model: 'nope' })).rejects.toThrow();
    expect(s.configState().desired).toEqual({ model: 'm2' });
    await s.close();
  });

  it('a patch that fails mid-wire keeps the keys the engine already accepted', async () => {
    // A patch is several wire calls, not one. Validation passes for both keys
    // here, mode lands, then set_model is refused — the accepted write must
    // survive, because the engine really is in that mode now.
    const hub = makeHub({ MOCK_NO_CONFIG: '1', MOCK_MODELS: '1', MOCK_NO_SET_MODEL: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });

    await expect(s.setConfig({ mode: 'plan', model: 'deep' })).rejects.toThrow(NotSupportedError);
    expect(s.configState().desired).toEqual({ mode: 'plan' });
    await s.close();
  });
});

describe('configState(): observed', () => {
  it('seeds from session/new state with that source, and never from desired', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    const { desired, observed } = s.configState();

    expect(desired).toEqual({});
    // The mock reports mode 'default' and model 'm1' at creation.
    expect(observed.mode).toMatchObject({ value: 'default', source: 'session/new' });
    expect(observed.model).toMatchObject({ value: 'm1', source: 'session/new' });
    expect(typeof observed.mode!.observedAt).toBe('number');
    await s.close();
  });

  it('an acknowledged write does not by itself move observed', async () => {
    // The engine must say so. This is the whole separation: a write runskein made
    // is evidence about runskein, not about the engine.
    const hub = makeHub({ MOCK_NO_CONFIG: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    expect(s.configState().observed.mode?.value).toBe('default');

    await s.setConfig({ mode: 'plan' });
    expect(s.configState().desired.mode).toBe('plan');
    // set_mode is acknowledged but the mock reports nothing back, so the
    // observed mode must still be what the engine last actually said.
    expect(s.configState().observed.mode?.value).toBe('default');
    await s.close();
  });

  it('an engine-pushed current_mode_update moves observed.mode with no host action', async () => {
    const hub = makeHub({ MOCK_PUSH_MODE: 'plan' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    expect(s.configState().observed.mode).toMatchObject({
      value: 'default',
      source: 'session/new',
    });

    await s.prompt('hello');
    expect(s.configState().observed.mode).toMatchObject({
      value: 'plan',
      source: 'current_mode_update',
    });
    // Nothing was written, so nothing is desired.
    expect(s.configState().desired).toEqual({});
    await s.close();
  });

  it('a config_option_update carries source and the engine option id', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    await s.setConfig({ model: 'm2' });
    // The mock echoes the new option state as a notification.
    const observed = s.configState().observed;
    expect(observed.model).toMatchObject({
      value: 'm2',
      source: 'config_option_update',
      engineOptionId: 'model',
    });
    await s.close();
  });

  it('observedAt is the time of the report', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const hub = makeHub();
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
      expect(s.configState().observed.mode?.observedAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
      await s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an engine option runskein cannot map is recorded under its own id, never dropped', async () => {
    // MOCK_MULTI_CONFIG advertises 'fast-mode', which has no runskein alias.
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    const observed = s.configState().observed;
    expect(observed['fast-mode']).toMatchObject({
      source: 'session/new',
      engineOptionId: 'fast-mode',
    });
    // The category-aliased ones still land on their runskein keys.
    expect(observed.model?.value).toBe('m1');
    expect(observed.reasoning).toMatchObject({ value: 'low', engineOptionId: 'reasoning' });
    await s.close();
  });
});

describe('configState(): resume', () => {
  it('a native resume seeds observed from the session/resume report', async () => {
    const hub = makeHub({ MOCK_RESUME_STATE: '1' });
    const cwd = tmp('runskein-cfg-');
    const first = await hub.session({ engine: 'mock', cwd });
    await first.prompt('hello');
    const id = first.id;
    await first.close();

    const resumed = await hub.session({ engine: 'mock', cwd, resume: id });
    expect(resumed.resumeTier).toBe('native');
    expect(resumed.configState().observed.mode).toMatchObject({
      value: 'plan',
      source: 'session/resume',
    });
    expect(resumed.configState().observed.model).toMatchObject({
      value: 'm2',
      source: 'session/resume',
    });
    // A resumed session has asked for nothing yet.
    expect(resumed.configState().desired).toEqual({});
    await resumed.close();
  });

  it('a load-tier resume seeds observed under its own source, not the resume one', async () => {
    // A load really did observe state; attributing it to session/resume would
    // misreport which call the host's evidence came from.
    const hub = makeHub({ MOCK_NO_RESUME: '1', MOCK_RESUME_STATE: '1' });
    const cwd = tmp('runskein-cfg-');
    const first = await hub.session({ engine: 'mock', cwd });
    await first.prompt('hello');
    const id = first.id;
    await first.close();

    const resumed = await hub.session({ engine: 'mock', cwd, resume: id });
    expect(resumed.resumeTier).toBe('load');
    expect(resumed.configState().observed.mode).toMatchObject({
      value: 'plan',
      source: 'session/load',
    });
    expect(resumed.configState().observed.model).toMatchObject({
      value: 'm2',
      source: 'session/load',
      engineOptionId: 'model',
    });
    await resumed.close();
  });

  it('a silent resume leaves observed empty rather than claiming the old values', async () => {
    const hub = makeHub();
    const cwd = tmp('runskein-cfg-');
    const first = await hub.session({ engine: 'mock', cwd });
    await first.prompt('hello');
    const id = first.id;
    await first.close();

    const resumed = await hub.session({ engine: 'mock', cwd, resume: id });
    expect(resumed.resumeTier).toBe('native');
    // The mock's plain session/resume reports nothing, and runskein must not
    // invent state for it.
    expect(resumed.configState().observed).toEqual({});
    await resumed.close();
  });
});

describe('configState(): read-only', () => {
  it('issues no wire request', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    await s.setConfig({ model: 'm2' });

    // Spy after setup so only the getter's own traffic is counted.
    const spy = vi.spyOn(AcpConnection.prototype, 'rawRequest');
    for (let i = 0; i < 5; i++) s.configState();
    expect(spy).not.toHaveBeenCalled();
    await s.close();
  });

  it('a caller cannot rewrite an engine observation through the snapshot', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    const observation = s.configState().observed.mode!;
    expect(() => {
      (observation as { value: string }).value = 'tampered';
    }).toThrow();
    expect(s.configState().observed.mode?.value).toBe('default');
    await s.close();
  });

  it('returns a snapshot that later changes do not mutate', async () => {
    const hub = makeHub({ MOCK_PUSH_MODE: 'plan' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    const before = s.configState();
    await s.setConfig({ model: 'm2' });
    await s.prompt('hello');

    expect(before.desired).toEqual({});
    expect(before.observed.mode?.value).toBe('default');
    expect(s.configState().desired.model).toBe('m2');
    expect(s.configState().observed.mode?.value).toBe('plan');
    await s.close();
  });
});

describe('configState(): wire evidence of re-application', () => {
  it('a re-applied model write is visible on the wire, not just in desired', async () => {
    // The oracle for "runskein really wrote it" has to be the engine's own record
    // of what it received; asserting runskein's bookkeeping against itself proves
    // nothing.
    const dir = tmp('runskein-cfg-record-');
    const record = join(dir, 'set-config.jsonl');
    const hub = makeHub({ MOCK_RECORD_SET_CONFIG_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-cfg-') });
    await s.setConfig({ model: 'm2' });

    expect(existsSync(record)).toBe(true);
    const sent = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { configId: string; value: string });
    expect(sent).toContainEqual(expect.objectContaining({ configId: 'model', value: 'm2' }));
    expect(s.configState().desired.model).toBe('m2');
    await s.close();
  });
});

describe('configState(): independent per session', () => {
  it('two sessions on one engine do not share state', async () => {
    const hub = makeHub({}, {}, [mockAdapter()]);
    const cwd = tmp('runskein-cfg-');
    const a = await hub.session({ engine: 'mock', cwd });
    const b = await hub.session({ engine: 'mock', cwd });
    await a.setConfig({ model: 'm2' });

    expect(a.configState().desired).toEqual({ model: 'm2' });
    expect(b.configState().desired).toEqual({});
    await a.close();
    await b.close();
  });
});
