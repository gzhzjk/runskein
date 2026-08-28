import { describe, expect, it } from 'vitest';
import { ConfigError, EngineOperationError, UnauthenticatedError } from 'runskein';
import {
  isLiveEnvironmentErrorLine,
  isLiveEnvironmentUnavailable,
  isLiveCaseOptedIn,
  liveCaseOptInLabel,
  LIVE_E2E_EXTEND_GROUP,
  LivePinRejectedError,
  ownedLiveEnginePids,
  requiredModelFamilyPresent,
  withLiveTimeout,
} from '../src/liveSupport.js';

describe('live runner verdict boundaries', () => {
  it('keeps extended message-format cases behind one explicit e2e group', () => {
    const defaultIncludes = new Set<string>();
    expect(isLiveCaseOptedIn('OP-MSG-01', defaultIncludes)).toBe(false);
    expect(isLiveCaseOptedIn('KI-MSG-01', defaultIncludes)).toBe(false);
    expect(isLiveCaseOptedIn('OP-MSG-01', new Set([LIVE_E2E_EXTEND_GROUP]))).toBe(true);
    expect(isLiveCaseOptedIn('KI-MSG-01', new Set([LIVE_E2E_EXTEND_GROUP]))).toBe(true);
    expect(isLiveCaseOptedIn('PV-02', new Set([LIVE_E2E_EXTEND_GROUP]))).toBe(false);
    expect(liveCaseOptInLabel('OP-MSG-01')).toBe(LIVE_E2E_EXTEND_GROUP);
    expect(liveCaseOptInLabel('PV-02')).toBe('PV-02');
  });

  it('never waives a missing required model family', () => {
    expect(requiredModelFamilyPresent('opencode', ['openai/gpt-5'])).toBe(false);
    expect(requiredModelFamilyPresent('opencode', ['minimax/m2'])).toBe(true);
    expect(requiredModelFamilyPresent('codex', ['gpt-5.6-codex'])).toBe(true);
    expect(requiredModelFamilyPresent('kimi', ['gpt-5.6-codex'])).toBe(false);
    expect(requiredModelFamilyPresent('kimi', ['kimi-for-coding/k3'])).toBe(true);
    // claude-code has no live family (matrix: hints) — never gated.
    expect(requiredModelFamilyPresent('claude-code', [])).toBe(true);
  });

  it('selects crash-injection targets from exact ownership, not process text', () => {
    const entries = [
      { enginePid: 101, engineId: 'codex', ownerPid: 42 },
      { enginePid: 102, engineId: 'claude-code', ownerPid: 42 },
      { enginePid: 103, engineId: 'codex', ownerPid: 99 },
      { enginePid: 101, engineId: 'codex', ownerPid: 42 },
    ];
    expect(ownedLiveEnginePids(entries, 'codex', 42)).toEqual([101]);
    expect(ownedLiveEnginePids(entries, 'claude-code', 42)).toEqual([102]);
    expect(ownedLiveEnginePids(entries, 'kimi', 42)).toEqual([]);
  });

  it('waives typed environment failures, but not assertions or cleanup failures', () => {
    expect(isLiveEnvironmentUnavailable(new UnauthenticatedError('codex'))).toBe(true);
    expect(isLiveEnvironmentUnavailable(new Error('provider assertion failed'))).toBe(false);
    expect(
      isLiveEnvironmentUnavailable(
        new EngineOperationError({
          engineId: 'codex',
          operation: 'session/close',
          cause: new Error('network closed'),
        }),
      ),
    ).toBe(false);
    expect(
      isLiveEnvironmentUnavailable(
        new EngineOperationError({
          engineId: 'opencode',
          operation: 'session/prompt',
          cause: new Error('Internal error: Insufficient Balance'),
        }),
      ),
    ).toBe(true);
    // A declined live pin (wrapped at the pinned session-creation point) is an
    // environment mismatch on this machine, not a code defect.
    expect(
      isLiveEnvironmentUnavailable(
        new LivePinRejectedError(
          'pi',
          { config: { model: 'x' } },
          new ConfigError({ engineId: 'pi', key: 'model', message: "invalid model 'x'" }),
        ),
      ),
    ).toBe(true);
    // A bare ConfigError is config a case built itself being rejected — a real
    // defect, never waived.
    expect(
      isLiveEnvironmentUnavailable(new ConfigError({ engineId: 'pi', key: 'model', message: 'no' })),
    ).toBe(false);
  });

  it('classifies CLI [error] lines with the same rule core', () => {
    expect(
      isLiveEnvironmentErrorLine(
        '[error] EngineOperationError: engine \'kimi\' operation \'prompt\' failed: rate limit exceeded { engineId: "kimi", operation: "prompt" }',
      ),
    ).toBe(true);
    expect(
      isLiveEnvironmentErrorLine(
        "[error] EngineOperationError: engine 'kimi' operation 'session/close' failed: rate limit exceeded { operation: \"session/close\" }",
      ),
    ).toBe(false);
    // A bare ConfigError line does not waive: the CLI live suite recognises a
    // declined `-c` pin itself, at session creation (classifySessionFailure).
    expect(isLiveEnvironmentErrorLine('[error] ConfigError: unknown value { key: "model" }')).toBe(false);
    expect(isLiveEnvironmentErrorLine('[error] unexpected: TypeError: boom')).toBe(false);
    expect(isLiveEnvironmentErrorLine(undefined)).toBe(false);
    // Observed live: Claude Code reports quota exhaustion as "hit your limit".
    expect(
      isLiveEnvironmentErrorLine(
        "[error] EngineOperationError: engine 'claude-code' operation 'session/prompt' failed: Internal error: You've hit your limit · resets 6:20pm (Europe/Paris) { operation: \"session/prompt\" }",
      ),
    ).toBe(true);
  });

  it('rejects a timed-out operation and settles a completed operation', async () => {
    await expect(withLiveTimeout(Promise.resolve('ok'), 1_000, 'fast')).resolves.toBe('ok');
    await expect(withLiveTimeout(new Promise(() => {}), 5, 'stuck')).rejects.toThrow(
      'timeout after 5ms: stuck',
    );
  });
});
