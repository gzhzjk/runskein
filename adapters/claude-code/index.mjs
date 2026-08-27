/**
 * @runskein/adapter-claude-code — declarative adapter.
 *
 * Launches the Zed ACP wrapper for Claude Code via npx (shim-free: the
 * wrapper IS an ACP server). Swapping to an official ACP entry point, if one
 * appears, is a one-line change here.
 *
 * The model list is discovered from session/new's `models` and written with
 * session/set_model, so no static configHints are needed here.
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
  id: 'claude-code',
  launch: {
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    // npx cold-start downloads the wrapper; be generous.
    startTimeoutMs: 120_000,
  },
  // Measured: this wrapper does not exit when its stdin closes, so a host that
  // dies uncleanly leaves it running forever — every live run of the test suite
  // leaked exactly one. The watchdog ties its lifetime back to the host's. The
  // other three engines exit on their own and are spawned without it.
  supervise: true,
  // Thinking depth reaches this engine only at session creation. The wrapper
  // reads `session/new`'s `_meta.claudeCode.options` once, inside its own
  // session construction, and nothing afterwards changes what it read — so
  // runskein reports this as settable at creation and refuses a runtime write
  // rather than sending one that would be accepted and ignored.
  //
  // The budgets are this adapter's knowledge, not core's: `high` means a token
  // count here and something else on every other engine.
  //
  // This rides a wrapper contract, not ACP. It can stop working on any release
  // of @zed-industries/claude-code-acp without an error — the setting would
  // simply return to its default — so it is guarded by a live case that
  // asserts thinking actually increased, not by this declaration alone.
  creationConfig: {
    reasoning: {
      meta: ['claudeCode', 'options', 'maxThinkingTokens'],
      values: { low: 4000, medium: 10000, high: 32000 },
      description: 'Thinking budget, applied when the session is created',
    },
  },
  errorPatterns: [{ cause: 'auth', match: 'Authentication required' }],
  /**
   * Probe whether the underlying Claude Code CLI is installed.
   * @returns installed flag, version, and a login hint when unavailable.
   */
  async detect() {
    // The wrapper drives the Claude Code CLI — its presence and login state
    // are what matter, not npx's.
    const version = await tryVersion('claude', ['--version']);
    if (version === undefined) {
      return { installed: false, loginHint: 'install Claude Code, then: claude /login' };
    }
    return { installed: true, version, loginHint: 'claude /login' };
  },
};
