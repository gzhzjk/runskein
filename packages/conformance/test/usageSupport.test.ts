import { describe, expect, it } from 'vitest';
import { readUsageUpdate } from '../src/usageSupport.js';

describe('usage_update wire reading', () => {
  it('recurses through nested usage objects like core', () => {
    expect(readUsageUpdate({ usage: { usage: { inputTokens: 12 } } })).toEqual({
      fields: ['input'],
      values: { input: 12 },
    });
  });

  it('does not fall back to top-level fields when usage is an array', () => {
    expect(readUsageUpdate({ usage: [], inputTokens: 12 })).toEqual({ fields: [], values: {} });
  });
});
