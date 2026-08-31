/**
 * @runskein/adapter-opencode — declarative adapter:
 * launch data + a detect() probe, nothing more. Session logic, event
 * mapping, and process management are core's, uniformly.
 */
import { execFile } from 'node:child_process';

/** Run `cmd args…`; resolve stdout, or undefined when unrunnable. The 20s
 * budget covers cold CI starts of 100MB+ self-contained binaries — a 5s cap
 * misreports them as not-installed on first exec (warm runs finish in <1s). */
function tryVersion(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 20_000 }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim());
    });
  });
}

export default {
  specVersion: 1,
  id: 'opencode',
  launch: { command: 'opencode', args: ['acp'], startTimeoutMs: 30_000 },
  // opencode identifies its own session and its caller in the environment it
  // passes down. The patterns are anchored on those two names alone:
  // `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` are configuration a host
  // deliberately sets — the live suite passes permissions that way — and
  // scrubbing them would silently discard it.
  envScrubExtra: [/^OPENCODE_(SESSION|CALLER)/],
  errorPatterns: [{ cause: 'auth', match: 'Authentication required' }],
  /**
   * opencode reports per-turn token accounting on the prompt response's
   * top-level `usage` object — measured live across three turns (decision
   * 033): input shrinks to the non-cached delta while `cachedReadTokens`
   * grows, and `totalTokens` = input + cached + output each turn. Its
   * `cachedReadTokens` name is not in core's built-in alias table, so only
   * it is declared; the `{used,size}` gauge on its usage_update stays
   * unfolded.
   */
  usage: {
    source: { kind: 'prompt_response_meta', path: ['usage'] },
    tokens: { cacheRead: ['cachedReadTokens'] },
    semantics: 'per-turn',
  },
  /**
   * Probe whether the engine binary is installed and report its version.
   * @returns installed flag, version, and a login hint when unavailable.
   */
  async detect() {
    const version = await tryVersion('opencode', ['--version']);
    if (version === undefined) {
      return { installed: false, loginHint: 'install opencode, then: opencode auth login' };
    }
    // Auth state is not probed here (expensive, engine-version dependent):
    // authenticated stays undefined = unknown; the login hint covers failures.
    return { installed: true, version, loginHint: 'opencode auth login' };
  },
};
