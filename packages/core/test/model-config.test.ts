/**
 * Model selection, which engines expose on its own protocol surface: a
 * `models` list returned by session/new, written with session/set_model.
 *
 * Treating the model as an ordinary config option was what made it look
 * unsettable on engines that report no configOptions at all — the value
 * validated against a static adapter hint and then had nowhere to go.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { ConfigError, NotSupportedError } from '../src/errors.js';
import type { EngineAdapter } from '../src/types.js';
import { FIXTURE, tmp } from './testkit.js';

/** An engine shaped like claude-code: models on the wire, no config options. */
function modelAdapter(env: Record<string, string> = {}): EngineAdapter {
  return {
    specVersion: 1,
    id: 'mock',
    launch: {
      command: process.execPath,
      args: [FIXTURE],
      env: { MOCK_MODELS: '1', MOCK_NO_CONFIG: '1', ...env },
      startTimeoutMs: 10_000,
    },
  };
}

const hubs: Hub[] = [];
function makeHub(adapter: EngineAdapter): Hub {
  const hub = new Hub({ discovery: false, adapters: [adapter], store: jsonlStore(tmp('runskein-model-')) });
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit()));
});

const recorded = (file: string): Array<Record<string, unknown>> =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe('describe() surfaces the engine models', () => {
  it('reports the advertised models and the current one', async () => {
    const hub = makeHub(modelAdapter());
    const d = await hub.describe('mock');
    expect(d.models).toEqual([
      { id: 'fast', name: 'Fast', description: 'quick replies' },
      { id: 'deep', name: 'Deep' },
    ]);
    expect(d.currentModel).toBe('fast');
  });

  it('omits models entirely when the engine advertises none', async () => {
    const hub = makeHub({
      specVersion: 1,
      id: 'mock',
      launch: { command: process.execPath, args: [FIXTURE], startTimeoutMs: 10_000 },
    });
    const d = await hub.describe('mock');
    expect(d.models).toBeUndefined();
    expect(d.currentModel).toBeUndefined();
  });
});

describe('setConfig({ model })', () => {
  it('writes through session/set_model, not set_config_option', async () => {
    const record = join(tmp('runskein-model-rec-'), 'set-model.jsonl');
    const hub = makeHub(modelAdapter({ MOCK_RECORD_SET_MODEL_FILE: record }));
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    await s.setConfig({ model: 'deep' });
    expect(recorded(record).map((r) => r['modelId'])).toEqual(['deep']);
    await s.close();
  });

  it('applies at creation through session({ config })', async () => {
    const record = join(tmp('runskein-model-rec-'), 'set-model.jsonl');
    const hub = makeHub(modelAdapter({ MOCK_RECORD_SET_MODEL_FILE: record }));
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-model-ws-'),
      config: { model: 'deep' },
    });
    expect(recorded(record).map((r) => r['modelId'])).toEqual(['deep']);
    await s.close();
  });

  it('rejects an unadvertised model before touching the engine', async () => {
    const record = join(tmp('runskein-model-rec-'), 'set-model.jsonl');
    const hub = makeHub(modelAdapter({ MOCK_RECORD_SET_MODEL_FILE: record }));
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    const error = await s.setConfig({ model: 'nope' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).validValues).toEqual(['fast', 'deep']);
    expect(recorded(record)).toHaveLength(0);
    await s.close();
  });

  it('names model among the valid keys on an engine that has no config options', async () => {
    // Measured on claude-code, which reports models and nothing else: an
    // unknown key answered "valid keys: mode" while setConfig({model}) worked.
    // A caller reading that would conclude the model is unsettable here, which
    // is precisely the misreading the model surface exists to prevent.
    const hub = makeHub(modelAdapter());
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    const error = await s.setConfig({ reasoning: 'high' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('model');
    await s.close();
  });

  it('surfaces a missing session/set_model as NotSupportedError', async () => {
    const hub = makeHub(modelAdapter({ MOCK_NO_SET_MODEL: '1' }));
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    await expect(s.setConfig({ model: 'deep' })).rejects.toBeInstanceOf(NotSupportedError);
    await s.close();
  });

  it('prefers the config option when the engine advertises BOTH surfaces', async () => {
    // codex is shaped this way: a `models` list AND a `model` config option,
    // with different id spellings on each side. Rerouting to session/set_model
    // would reject the config option's ids, which is a silent regression for
    // every caller that already pins a model on such an engine.
    const record = join(tmp('runskein-model-rec-'), 'set-config.jsonl');
    const setModel = join(tmp('runskein-model-rec-'), 'set-model.jsonl');
    const hub = makeHub({
      specVersion: 1,
      id: 'mock',
      launch: {
        command: process.execPath,
        args: [FIXTURE],
        // MOCK_MODELS on, MOCK_NO_CONFIG off: both surfaces present.
        env: {
          MOCK_MODELS: '1',
          MOCK_RECORD_SET_CONFIG_FILE: record,
          MOCK_RECORD_SET_MODEL_FILE: setModel,
        },
        startTimeoutMs: 10_000,
      },
    });
    const d = await hub.describe('mock');
    expect(d.models).toBeDefined();
    expect(d.configOptions.some((o) => o.id === 'model')).toBe(true);

    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    await s.setConfig({ model: 'm2' }); // a config-option id, absent from `models`
    expect(recorded(record).map((r) => r['configId'])).toEqual(['model']);
    expect(recorded(setModel)).toHaveLength(0);
    await s.close();
  });

  it('still routes model through set_config_option when that is where it lives', async () => {
    // Engines like opencode report model as an ordinary config option and
    // advertise no `models` list; that path must keep working unchanged.
    const record = join(tmp('runskein-model-rec-'), 'set-config.jsonl');
    const hub = makeHub({
      specVersion: 1,
      id: 'mock',
      launch: {
        command: process.execPath,
        args: [FIXTURE],
        env: { MOCK_RECORD_SET_CONFIG_FILE: record },
        startTimeoutMs: 10_000,
      },
    });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-model-ws-') });
    await s.setConfig({ model: 'm2' });
    expect(recorded(record).map((r) => r['configId'])).toEqual(['model']);
    await s.close();
  });
});
