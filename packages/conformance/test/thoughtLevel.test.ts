import { describe, expect, it } from 'vitest';
import type { EngineDescriptor } from 'runskein';
import type { WireFrame } from '@runskein/core/internal';
import {
  optionValues,
  thoughtLevelExtremes,
  thoughtLevelOption,
  THOUGHT_EFFECT_RATIO,
  THOUGHT_LEVEL_RANK,
  wireOutputTokens,
} from '../src/liveSupport.js';

type ConfigOption = EngineDescriptor['configOptions'][number];

/** A select option carrying flat values, as every engine but none publishes them. */
function selectOption(id: string, values: string[]): ConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    category: 'thought_level',
    options: values.map((value) => ({ value, name: value })),
  } as ConfigOption;
}

// Every list below was read from `hub.describe()` against the real engine on
// 2026-08-31. They are the point of this file: the extremes must come from a
// rank, because two of the four engines do not declare their levels in order.
const ADVERTISED = {
  opencode: ['minimal', 'low', 'medium', 'high', 'xhigh', 'none'],
  claudeCode: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  kimi: ['low', 'high', 'max'],
} as const;

describe('thought-level extremes (CF-06, CF-10)', () => {
  it('ranks the levels rather than trusting declaration order', () => {
    // opencode lists `none` last and claude-code lists `default` first, so
    // taking the first and last declared values picked opencode's *weakest*
    // setting as the one to measure. That is the defect this ranking replaced.
    expect(thoughtLevelExtremes(selectOption('effort', [...ADVERTISED.opencode]))).toEqual({
      low: 'none',
      high: 'xhigh',
    });
    expect(thoughtLevelExtremes(selectOption('effort', [...ADVERTISED.claudeCode]))).toEqual({
      low: 'low',
      high: 'max',
    });
    expect(thoughtLevelExtremes(selectOption('reasoning_effort', [...ADVERTISED.codex]))).toEqual({
      low: 'low',
      high: 'max',
    });
    expect(thoughtLevelExtremes(selectOption('thinking', [...ADVERTISED.kimi]))).toEqual({
      low: 'low',
      high: 'max',
    });
  });

  it('would have measured the wrong level on two of the four engines positionally', () => {
    // Pins the defect itself, so a future "simplification" back to positional
    // selection fails here rather than silently measuring the wrong setting.
    const positional = (values: readonly string[]) => ({
      low: values[0]!,
      high: values[values.length - 1]!,
    });
    expect(positional(ADVERTISED.opencode)).not.toEqual(
      thoughtLevelExtremes(selectOption('effort', [...ADVERTISED.opencode])),
    );
    expect(positional(ADVERTISED.claudeCode)).not.toEqual(
      thoughtLevelExtremes(selectOption('effort', [...ADVERTISED.claudeCode])),
    );
  });

  it('never lets `default` stand in for an extreme', () => {
    // `default` means "whatever this model does unasked" — not a point on the
    // scale. Comparing against it would measure the model, not the setting.
    expect(THOUGHT_LEVEL_RANK['default']).toBeUndefined();
    expect(thoughtLevelExtremes(selectOption('effort', ['default', 'low', 'max']))).toEqual({
      low: 'low',
      high: 'max',
    });
    // `default` plus one ranked value leaves no pair to compare.
    expect(thoughtLevelExtremes(selectOption('effort', ['default', 'max']))).toBeUndefined();
  });

  it('gives up rather than guessing when it cannot rank the values', () => {
    expect(thoughtLevelExtremes(selectOption('effort', ['fast', 'slow']))).toBeUndefined();
    expect(thoughtLevelExtremes(selectOption('effort', []))).toBeUndefined();
  });

  it('is independent of the order the engine happens to send', () => {
    expect(thoughtLevelExtremes(selectOption('effort', ['max', 'none', 'medium']))).toEqual({
      low: 'none',
      high: 'max',
    });
  });

  it('flattens grouped options', () => {
    const grouped = {
      id: 'effort',
      name: 'effort',
      type: 'select',
      options: [
        { name: 'cheap', options: [{ value: 'low', name: 'low' }] },
        { name: 'dear', options: [{ value: 'max', name: 'max' }] },
      ],
    } as unknown as ConfigOption;
    expect(optionValues(grouped)).toEqual(['low', 'max']);
    expect(thoughtLevelExtremes(grouped)).toEqual({ low: 'low', high: 'max' });
  });

  it('finds the option by id first and by category second', () => {
    const withId = {
      configOptions: [selectOption('reasoning_effort', ['low', 'max'])],
    } as EngineDescriptor;
    expect(thoughtLevelOption(withId)?.id).toBe('reasoning_effort');
    // kimi calls it `thinking`; only the category identifies it.
    const byCategory = {
      configOptions: [selectOption('thinking', ['low', 'max'])],
    } as EngineDescriptor;
    expect(thoughtLevelOption(byCategory)?.id).toBe('thinking');
    const none = { configOptions: [] } as unknown as EngineDescriptor;
    expect(thoughtLevelOption(none)).toBeUndefined();
  });
});

describe('turn output tokens off the wire (CF-10 tier 3)', () => {
  const promptResponse = (outputTokens: number, id: number): WireFrame =>
    ({
      direction: 'in',
      id,
      result: { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens, totalTokens: 47717 } },
    }) as unknown as WireFrame;

  // opencode and codex send this during the same turn and it carries an
  // `outputTokens` of its own. Reading it would measure a different thing.
  const usageNotification = {
    direction: 'in',
    method: 'session/update',
    params: { update: { sessionUpdate: 'usage_update', outputTokens: 999_999 } },
  } as unknown as WireFrame;

  const outbound = {
    direction: 'out',
    method: 'session/prompt',
    params: {},
  } as unknown as WireFrame;

  it('reads the prompt response and nothing else', () => {
    expect(wireOutputTokens([outbound, usageNotification, promptResponse(86, 7)])).toBe(86);
  });

  it('takes the last response when a capture spans more than one turn', () => {
    expect(wireOutputTokens([promptResponse(3, 7), promptResponse(9276, 12)])).toBe(9276);
  });

  it('reports undefined rather than zero when the engine sent no usage', () => {
    // Zero would read as "the model produced nothing", which is a claim; the
    // absence of a number is not. CF-10 skips on undefined and would compare
    // against a fabricated zero.
    expect(wireOutputTokens([outbound, usageNotification])).toBeUndefined();
    expect(wireOutputTokens([])).toBeUndefined();
    expect(
      wireOutputTokens([{ direction: 'in', id: 1, result: null } as unknown as WireFrame]),
    ).toBeUndefined();
  });
});

describe('the effect margin (CF-10 tier 3)', () => {
  // Both sides measured on claude-code, 2026-08-31, same prompt each time.
  const SIGNAL: [low: number, high: number][] = [
    [3, 4915],
    [86, 6378],
    [3, 1806],
    [3, 9276],
    [3, 7039],
    // The tightest real separation seen so far. The `low` arm varies between 3
    // and 86 output tokens depending on how terse the model's answer happens to
    // be, and that variation — not the strong arm — is what compresses the
    // ratio. It is the number the margin has to stay under.
    [86, 1600],
  ];
  // Negative controls: CF-10 run with *both* arms writing the same level, so
  // nothing changed between the two turns.
  const NOISE: [low: number, high: number][] = [
    [4229, 8268],
    [9369, 3614],
  ];
  const moved = (low: number | undefined, high: number) =>
    low !== undefined && high > low * THOUGHT_EFFECT_RATIO;

  it('passes every measured real separation', () => {
    for (const [low, high] of SIGNAL) expect(moved(low, high)).toBe(true);
  });

  it('warns on every measured same-level control', () => {
    for (const [low, high] of NOISE) expect(moved(low, high)).toBe(false);
  });

  it('sits between the measured noise and the measured signal', () => {
    // The quantity that constrains the margin is the *spread* between two turns
    // at the same level — how far apart identical settings land — not the
    // signed ratio. One control came back inverted (the nominally stronger arm
    // spent less), so `high / low` reads 0.39 there and understates the noise
    // as 1.96x; measuring it that way let a 2x margin survive this check, which
    // is the regression the check exists to catch.
    const spread = ([a, b]: [number, number]) => Math.max(a, b) / Math.min(a, b);
    const noiseCeiling = Math.max(...NOISE.map(spread));
    const weakestSignal = Math.min(...SIGNAL.map(([low, high]) => high / low));
    expect(noiseCeiling).toBeGreaterThan(2.5);
    expect(noiseCeiling).toBeLessThan(THOUGHT_EFFECT_RATIO);
    expect(THOUGHT_EFFECT_RATIO).toBeLessThan(weakestSignal);
  });

  it('never calls a missing control turn an effect', () => {
    expect(moved(undefined, 9276)).toBe(false);
  });
});
