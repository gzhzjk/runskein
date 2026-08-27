/**
 * Acceptance cases for prompting and configuration: the content-block
 * variants a prompt may carry, the stop reasons a turn may end with, and
 * discovering then applying an engine's config options. Driven by the mock
 * agent, so every variant is deterministic.
 *
 * Test-plan cases: PV-02, PV-04, PV-05, PV-06, PV-09, PV-10, PV-11, CF-01,
 * CF-06, CF-07, CF-09, OS-02, SL-14.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import { makeHub, tmp } from './testkit.js';

/** Records the update stream for one prompt call. */
async function promptUpdates(
  env: Record<string, string>,
  prompt: string,
): Promise<{ events: TranscriptEvent[]; stopReason: string }> {
  const hub = makeHub(env);
  const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pv-') });
  const events: TranscriptEvent[] = [];
  s.on('update', (e) => events.push(e));
  const r = await s.prompt(prompt);
  await s.close();
  return { events, stopReason: r.stopReason };
}

describe('D — prompt & content variants (PV)', () => {
  it('PV-02: thinking chunks pass through structurally faithful, never fabricated', async () => {
    const { events } = await promptUpdates({ MOCK_THOUGHT: '1' }, 'think carefully');
    const thought = events.find((e) => e.update.sessionUpdate === 'agent_thought_chunk');
    expect(thought).toBeDefined();
    expect(thought!.update.content).toEqual({ type: 'text', text: 'pondering…' });
  });

  it('PV-04: tool-call diff content passes through untouched', async () => {
    const { events } = await promptUpdates({ MOCK_TOOL_DIFF: '1' }, 'edit the file');
    const call = events.find((e) => e.update.sessionUpdate === 'tool_call');
    expect(call?.update.content).toEqual([
      { type: 'diff', path: '/tmp/x.txt', oldText: 'old', newText: 'new' },
    ]);
  });

  it('PV-05: plan / plan_update / plan_removed streams pass through', async () => {
    const { events } = await promptUpdates({ MOCK_PLAN: '1' }, 'plan then do it');
    const plan = events.find((e) => e.update.sessionUpdate === 'plan');
    expect(plan?.update.entries).toEqual([{ content: 'step one', priority: 'high', status: 'pending' }]);
    const planUpdate = events.find((e) => e.update.sessionUpdate === 'plan_update');
    expect(planUpdate?.update.plan).toEqual({
      type: 'file',
      planId: 'plan-1',
      uri: 'file:///plan.md',
    });
    const planRemoved = events.find((e) => e.update.sessionUpdate === 'plan_removed');
    expect(planRemoved?.update).toMatchObject({ planId: 'plan-1' });
  });

  it('PV-06: available_commands_update observed on the first turn', async () => {
    const { events } = await promptUpdates({ MOCK_AVAILABLE_COMMANDS: '1' }, 'go');
    const ac = events.find((e) => e.update.sessionUpdate === 'available_commands_update');
    expect(ac?.update.availableCommands).toEqual([{ name: 'run', description: 'run a command' }]);
  });

  it('PV-07: multimodal ContentBlock[] (image) reaches the wire intact', async () => {
    const record = join(tmp('runskein-pv07-'), 'prompt.jsonl');
    const hub = makeHub({ MOCK_RECORD_PROMPT_FILE: record });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pv07-') });
    const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const r = await s.prompt([{ type: 'text', text: 'describe this image' }, image]);
    expect(r.stopReason).toBe('end_turn');

    // The fixture recorded exactly what runskein sent on the wire: both the
    // text block and the image block survive intact (not dropped by core).
    const lines = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Array<Record<string, unknown>>);
    expect(lines[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining(image),
        expect.objectContaining({ type: 'text', text: 'describe this image' }),
      ]),
    );
    await s.close();
  });

  it('PV-09: refusal resolves stopReason=refusal, never rejects or hangs', async () => {
    const hub = makeHub({ MOCK_REFUSAL: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pv-') });
    const r = await s.prompt('do something harmful');
    expect(r.stopReason).toBe('refusal');
    await s.close();
  });

  it('PV-10: max_tokens resolves through the public stopReason union', async () => {
    const hub = makeHub({ MOCK_MAX_TOKENS: '1' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-pv-') });
    const r = await s.prompt('keep going forever');
    expect(r.stopReason).toBe('max_tokens');
    await s.close();
  });

  it('PV-11: a long single turn buffers >10 updates, seq monotonic, resolves once', async () => {
    const { events, stopReason } = await promptUpdates({ MOCK_LONG_TURN: '1' }, 'a long story');
    const chunks = events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk');
    expect(chunks.length).toBeGreaterThan(10);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(stopReason).toBe('end_turn');
  });
});

describe('OS-02 — no terminal stream hangs', () => {
  it('agent-side terminal content passes through read-only as tool content', async () => {
    const { events } = await promptUpdates({ MOCK_TERMINAL_CONTENT: '1' }, 'run ls');
    const call = events.find(
      (e) => e.update.sessionUpdate === 'tool_call' && String(e.update.toolCallId).startsWith('term-'),
    );
    expect(call?.update.content).toEqual([{ type: 'terminal', terminalId: 'term-1' }]);
  });
});

describe('SL-14 — event unsubscription', () => {
  it('update and status unsubscription stop delivery; a control callback still fires', async () => {
    const hub = makeHub({ MOCK_PROMPT_DELAY_MS: '40' });
    const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sl14-') });
    const removedUpdate: string[] = [];
    const removedStatus: string[] = [];
    const keptUpdate: string[] = [];
    const keptStatus: string[] = [];
    const unUpdate = s.on('update', () => removedUpdate.push('x'));
    const unStatus = s.on('status', (st) => removedStatus.push(st));
    const keepUpdate = s.on('update', () => keptUpdate.push('x'));
    const keepStatus = s.on('status', (st) => keptStatus.push(st));

    await s.prompt('one');
    const afterTurnOne = removedUpdate.length;
    unUpdate();
    unStatus();
    await s.prompt('two');

    expect(afterTurnOne).toBeGreaterThan(0);
    expect(removedUpdate).toHaveLength(afterTurnOne); // nothing after unsubscribing
    expect(keptUpdate.length).toBeGreaterThan(afterTurnOne);
    expect(removedStatus).toEqual(['running', 'idle']); // only turn 1
    expect(keptStatus.length).toBeGreaterThanOrEqual(4); // turns 1 + 2
    keepUpdate();
    keepStatus();
    await s.close();
  });
});

describe('G — config discovery & control (CF)', () => {
  it('CF-01: describe() maps model/thought_level/model_config/mode categories', async () => {
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1' });
    const d = await hub.describe('mock');
    expect(d.configOptions.map((o) => o.category)).toEqual([
      'model',
      'thought_level',
      'model_config',
      'mode',
    ]);
  });

  it('CF-06: thought/reasoning levels validated against the descriptor', async () => {
    const record = join(tmp('runskein-cf06-'), 'set-config.jsonl');
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1', MOCK_RECORD_SET_CONFIG_FILE: record });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cf06-'),
      config: { reasoning: 'high' },
    });
    await s.setConfig({ reasoning: 'low' });
    await s.setConfig({ reasoning: 'max' });

    const before = countLines(record);
    const err = await s.setConfig({ reasoning: 'bogus' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ key: 'reasoning', validValues: ['low', 'high', 'max'] });
    expect(countLines(record)).toBe(before); // fail-fast: no wire request for an invalid value
    await s.close();
  });

  it('CF-07: fast-mode (model_config) toggle validated before the wire', async () => {
    const record = join(tmp('runskein-cf07-'), 'set-config.jsonl');
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1', MOCK_RECORD_SET_CONFIG_FILE: record });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cf07-'),
      config: { 'fast-mode': true },
    });
    await s.setConfig({ 'fast-mode': false });
    await s.setConfig({ 'fast-mode': true });

    const before = countLines(record);
    const err = await s.setConfig({ 'fast-mode': 'yes' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ key: 'fast-mode', validValues: ['true', 'false'] });
    expect(countLines(record)).toBe(before); // fail-fast: no wire request
    await s.close();
  });

  it('CF-09: accepted config is sent as set_config_option; engine state matches', async () => {
    const record = join(tmp('runskein-cf09-'), 'set-config.jsonl');
    const hub = makeHub({ MOCK_MULTI_CONFIG: '1', MOCK_RECORD_SET_CONFIG_FILE: record });
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-cf09-'),
      config: { model: 'm2' },
    });
    await s.setConfig({ reasoning: 'high' });

    const lines = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { configId: string; value: unknown });
    expect(lines).toContainEqual(expect.objectContaining({ configId: 'model', value: 'm2' }));
    // The 'reasoning' KEY resolves to the thought_level-category option and
    // the wire targets that option's ADVERTISED id — here
    // literally 'reasoning'; engines advertising id 'thought_level' get that.
    expect(lines).toContainEqual(expect.objectContaining({ configId: 'reasoning', value: 'high' }));

    // The engine's emitted config state reflects the accepted value.
    const events: TranscriptEvent[] = [];
    const un = s.on('update', (e) => events.push(e));
    await s.setConfig({ model: 'm1' });
    un();
    const configUpdate = events.find((e) => e.update.sessionUpdate === 'config_option_update');
    expect(configUpdate?.update.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'model', category: 'model', currentValue: 'm1' }),
      ]),
    );
    await s.close();
  });
});

function countLines(p: string): number {
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length;
}
