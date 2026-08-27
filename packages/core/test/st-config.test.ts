/**
 * ST-CFG-01 / ST-CFG-02 — desired versus observed config state (AC-8.1, AC-8.3).
 *
 * The failure these guard against is a comfortable lie: a host pins a model,
 * the write is acknowledged, and the API reports the engine "is on" that model
 * when in truth nothing ever said so. Most engines report no config state at
 * all, so the only honest answer for them is silence — which means the
 * load-bearing assertions here are the negative ones. An acknowledged write
 * must move `desired` and leave `observed` exactly where the engine last put
 * it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpConnection } from '../src/acp/connection.js';
import { ConfigError } from '../src/errors.js';
import { makeHub, tmp } from './testkit.js';

const cwd = (): string => tmp('runskein-st-cfg-');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ST-CFG-01 — desired vs observed (AC-8.1)', () => {
  it('an acknowledged write moves desired and never touches observed', async () => {
    // session/set_mode is the honest case: the mock acknowledges it and
    // reports nothing back, exactly like an engine that never volunteers state.
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: cwd() });

    const atCreation = s.configState();
    expect(atCreation.desired['mode']).toBeUndefined();
    expect(atCreation.observed['mode']?.value).toBe('default');
    expect(atCreation.observed['mode']?.source).toBe('session/new');
    const observedAtCreation = atCreation.observed['mode']?.observedAt;

    await s.setConfig({ mode: 'plan' });

    const after = s.configState();
    expect(after.desired['mode']).toBe('plan');
    // The whole point of the split: the engine never confirmed 'plan', so the
    // observation must still read 'default' from session/new. A copy of
    // `desired` appearing here would be the silent lie this API exists to stop.
    expect(after.observed['mode']?.value).toBe('default');
    expect(after.observed['mode']?.source).toBe('session/new');
    expect(after.observed['mode']?.observedAt).toBe(observedAtCreation);
  });

  it('an engine-reported write moves both, and records source, time and option id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: cwd() });

    const reportedAt = new Date('2026-08-08T12:00:00.000Z').getTime();
    vi.setSystemTime(reportedAt);
    await s.setConfig({ model: 'm2' });

    const state = s.configState();
    expect(state.desired['model']).toBe('m2');
    // The mock echoes a config_option_update, so here the engine really did say
    // it — provenance and timing must come from that report.
    expect(state.observed['model']?.value).toBe('m2');
    expect(state.observed['model']?.source).toBe('config_option_update');
    expect(state.observed['model']?.observedAt).toBe(reportedAt);
    // The wire message carried a config id, so it is traceable.
    expect(state.observed['model']?.engineOptionId).toBe('model');
  });

  it('an engine-pushed current_mode_update moves observed with no host action', async () => {
    const hub = makeHub({ MOCK_PUSH_MODE: 'plan' });
    const s = await hub.session({ engine: 'mock', cwd: cwd() });
    await s.prompt('anything');

    const state = s.configState();
    expect(state.observed['mode']?.value).toBe('plan');
    expect(state.observed['mode']?.source).toBe('current_mode_update');
    // Nobody wrote a mode, so desired must stay empty — an engine-initiated
    // change is not a host intention.
    expect(state.desired['mode']).toBeUndefined();
    // A pushed mode carries no option id on the wire; inventing one would make
    // an absent identifier indistinguishable from a real one.
    expect(state.observed['mode']?.engineOptionId).toBeUndefined();
  });

  it('a rejected write moves neither map', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: cwd() });
    const before = s.configState();

    await expect(s.setConfig({ model: 'nonexistent-model' })).rejects.toThrow(ConfigError);

    const after = s.configState();
    expect(after.desired['model']).toBeUndefined();
    expect(after.observed['model']?.value).toBe(before.observed['model']?.value);
  });

  it('records creation state from session/new, with an option id where the wire carries one', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: cwd() });

    const state = s.configState();
    // configOptions entries carry ids…
    expect(state.observed['model']?.value).toBe('m1');
    expect(state.observed['model']?.source).toBe('session/new');
    expect(state.observed['model']?.engineOptionId).toBe('model');
    // …the modes block does not.
    expect(state.observed['mode']?.source).toBe('session/new');
    expect(state.observed['mode']?.engineOptionId).toBeUndefined();
    // Creation observations are engine-reported, so desired stays empty until
    // a caller actually writes something.
    expect(state.desired).toEqual({});
  });

  it('keys an unmapped engine option under its own id and says so', async () => {
    // An option whose category runskein has no key for must still be recorded:
    // dropping it would be exactly the silent degradation this capability
    // exists to prevent. Its key is then the raw engine id, and
    // engineOptionId is what makes that recognisable rather than mysterious
    // (the alias test being `key !== engineOptionId`).
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1' });
    const s = await hub.session({ engine: 'mock', cwd: cwd() });

    const { observed } = s.configState();
    const unmapped = Object.entries(observed).filter(([key, o]) => key === o.engineOptionId);
    expect(unmapped.length).toBeGreaterThan(0);
    for (const [key, o] of unmapped) {
      expect(o.engineOptionId).toBe(key);
      expect(o.source).toBe('session/new');
    }
    // Mapped entries keep their runskein key and stay distinguishable.
    expect(observed['model']?.engineOptionId).toBe('model');
    expect(observed['reasoning']?.engineOptionId).toBe('reasoning');
    expect(observed['reasoning']?.value).toBe('low');
  });

  it('records resume-reported state under session/resume', async () => {
    const hub = makeHub({ MOCK_RESUME_STATE: '1' });
    const first = await hub.session({ engine: 'mock', cwd: cwd() });
    await first.prompt('seed the transcript');
    await first.close();

    const resumed = await hub.session({ engine: 'mock', cwd: cwd(), resume: first.id });
    const state = resumed.configState();
    // The engine reported different values on resume than it did at creation;
    // observed must follow the engine, and name the message it came from.
    expect(state.observed['mode']?.value).toBe('plan');
    expect(state.observed['mode']?.source).toBe('session/resume');
    expect(state.observed['model']?.value).toBe('m2');
    expect(state.observed['model']?.source).toBe('session/resume');
    expect(state.observed['model']?.engineOptionId).toBe('model');
  });

  // Caveat that must survive: the fixture assumes the session/load RESPONSE
  // carries config state. That is structurally possible (loadSession returns an
  // untyped record) but has never been measured on a real engine. If engines
  // instead report load-tier state through notifications during replay, the
  // source label stays right and the ingestion point moves — this case would
  // need to move with it.
  it('records load-tier resume state under session/load', async () => {
    const hub = makeHub({ MOCK_LOAD_STATE: '1', MOCK_NO_RESUME: '1' });
    const first = await hub.session({ engine: 'mock', cwd: cwd() });
    await first.prompt('seed the transcript');
    await first.close();

    const resumed = await hub.session({ engine: 'mock', cwd: cwd(), resume: first.id });
    expect(resumed.resumeTier).toBe('load');
    const state = resumed.configState();
    expect(state.observed['mode']?.value).toBe('plan');
    expect(state.observed['mode']?.source).toBe('session/load');
    expect(state.observed['model']?.source).toBe('session/load');
  });
});

describe('ST-CFG-02 — the getter is read-only (AC-8.3)', () => {
  it('issues no wire request', async () => {
    const hub = makeHub();
    const s = await hub.session({ engine: 'mock', cwd: cwd() });
    await s.setConfig({ mode: 'plan' });

    // Spying on rawRequest rather than one wire method covers every request
    // the connection can make, including any added later.
    const spy = vi.spyOn(AcpConnection.prototype, 'rawRequest');
    const state = s.configState();
    s.configState();

    expect(spy).not.toHaveBeenCalled();
    expect(state.desired['mode']).toBe('plan');
  });

  it('returns a snapshot that later reports cannot mutate retroactively', async () => {
    // A getter handing out its live internal maps would let a later engine
    // report rewrite a value a caller already read and acted on.
    const hub = makeHub({ MOCK_PUSH_MODE: 'plan' });
    const s = await hub.session({ engine: 'mock', cwd: cwd() });

    const before = s.configState();
    expect(before.observed['mode']?.value).toBe('default');
    await s.prompt('trigger the engine-side mode change');

    expect(before.observed['mode']?.value).toBe('default');
    expect(s.configState().observed['mode']?.value).toBe('plan');
  });
});
