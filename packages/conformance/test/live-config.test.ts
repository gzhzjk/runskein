/**
 * The per-adapter live config files are the single source of truth for live
 * model pins — this suite keeps them present and well-formed without starting
 * any engine, so a broken or missing file fails the default gate rather than
 * the next live run.
 */
import { describe, expect, it } from 'vitest';
import { builtinAdapters } from 'runskein';
import {
  liveConfigFor,
  liveConfigPath,
  liveModelEnvVar,
  livePinRejectionReason,
} from '../src/liveSupport.js';

describe('per-adapter live.config.json', () => {
  it('exists and parses for every built-in adapter, with a non-empty model pin', () => {
    for (const adapter of builtinAdapters) {
      const model = liveConfigFor(adapter.id).config?.['model'];
      expect(typeof model === 'string' && model.trim() !== '', `${adapter.id} pins no model`).toBe(true);
    }
  });

  it('maps engine ids to package files and override variables', () => {
    expect(liveConfigPath('pi')).toMatch(/adapters\/pi\/live\.config\.json$/);
    expect(liveModelEnvVar('claude-code')).toBe('RUNSKEIN_LIVE_MODEL_CLAUDE_CODE');
  });

  it('lets RUNSKEIN_LIVE_MODEL_<ID> override the file pin, read at call time', () => {
    process.env['RUNSKEIN_LIVE_MODEL_PI'] = 'override/provider-model';
    try {
      expect(liveConfigFor('pi').config?.['model']).toBe('override/provider-model');
    } finally {
      delete process.env['RUNSKEIN_LIVE_MODEL_PI'];
    }
    expect(liveConfigFor('pi').config?.['model']).not.toBe('override/provider-model');
  });

  it('rejects a whitespace-only override like an empty file pin', () => {
    process.env['RUNSKEIN_LIVE_MODEL_PI'] = '   ';
    try {
      expect(() => liveConfigFor('pi')).toThrow(/override must be a non-empty model id/);
    } finally {
      delete process.env['RUNSKEIN_LIVE_MODEL_PI'];
    }
  });

  it('keeps opencode’s launch-env override in its file, not in runner source', () => {
    // The all-"ask" permission layer moved here from an inline constant in the
    // live runner: per-engine live knowledge belongs to the adapter package.
    const env = liveConfigFor('opencode').env;
    expect(env?.['OPENCODE_CONFIG_CONTENT']).toContain('"ask"');
  });

  it('names the file, the pin and the override in the rejection reason', () => {
    const reason = livePinRejectionReason('pi', liveConfigFor('pi'));
    expect(reason).toContain('adapters/pi/live.config.json');
    expect(reason).toContain('RUNSKEIN_LIVE_MODEL_PI');
    expect(reason).toContain(liveConfigFor('pi').config?.['model'] as string);
    // Every pinned key is named, not just the model: a rejected reasoning or
    // mode pin must be identifiable from the skip message.
    const multi = livePinRejectionReason('pi', { config: { model: 'm', reasoning: 'high' } });
    expect(multi).toContain("model 'm'");
    expect(multi).toContain("reasoning 'high'");
  });

  it('rejects an engine with no adapter package', () => {
    expect(() => liveConfigFor('no-such-engine')).toThrow(/no adapter package resolves/);
  });
});
