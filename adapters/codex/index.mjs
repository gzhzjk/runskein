/**
 * @runskein/adapter-codex — declarative adapter.
 *
 * Launches the ACP org's codex wrapper via npx (shim-free ACP server).
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

/** Check Codex's local credential state without making an engine request. */
function tryLoginStatus() {
  return new Promise((resolve) => {
    execFile('codex', ['login', 'status'], { timeout: 20_000 }, (error) => {
      resolve(error === null);
    });
  });
}

export default {
  specVersion: 1,
  id: 'codex',
  launch: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    // npx cold-start downloads the wrapper; be generous.
    startTimeoutMs: 120_000,
  },
  errorPatterns: [{ cause: 'auth', match: 'Authentication required' }],
  /**
   * codex reports token accounting on the prompt response's
   * `_meta.quota.token_count`, not in a usage_update notification
   * (decision 033). Its `cachedInputTokens`/`reasoningOutputTokens` names are
   * not in core's built-in alias table, so only they are declared — restating
   * a built-in alias would create a second place to keep it right. Reports
   * are per-turn counts; the `{used,size}` gauge it also streams is a
   * context-window meter and stays unfolded.
   */
  usage: {
    source: { kind: 'prompt_response_meta', path: ['_meta', 'quota', 'token_count'] },
    tokens: {
      cacheRead: ['cachedInputTokens'],
      thought: ['reasoningOutputTokens'],
    },
    semantics: 'per-turn',
  },
  /**
   * Probe whether the codex CLI is installed.
   * @returns installed flag, version, and a login hint when unavailable.
   */
  async detect() {
    const [version, authenticated] = await Promise.all([
      tryVersion('codex', ['--version']),
      tryLoginStatus(),
    ]);
    if (version === undefined) {
      return {
        installed: false,
        loginHint: 'install codex, then: codex login (ChatGPT or API key)',
      };
    }
    return { installed: true, version, authenticated, loginHint: 'codex login' };
  },
};
