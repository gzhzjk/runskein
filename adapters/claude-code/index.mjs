/**
 * @runskein/adapter-claude-code — declarative adapter.
 *
 * Launches Anthropic's ACP wrapper for Claude Code via npx (shim-free: the
 * wrapper IS an ACP server). It was `@zed-industries/claude-code-acp` until
 * that package was deprecated with a rename notice pointing here.
 *
 * Model choice is discovered rather than declared, so no static configHints
 * are needed — but where it is discovered moved with the rename: 0.16 listed
 * models on `session/new`, and this wrapper publishes them as a `model`
 * config option instead. Core reads both, and decision 009 makes the config
 * option win where an engine publishes both.
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
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    // npx cold-start downloads the wrapper; be generous.
    startTimeoutMs: 120_000,
  },
  // Claude Code marks its own session in the environment of everything it
  // runs, and this wrapper reads those markers as "you are already in a
  // session" and refuses to start — the measured failure the whole env scrub
  // exists for. One prefix covers both forms: the `CLAUDE_*` session
  // variables and the bare `CLAUDECODE` flag. Anchored, so a consumer's own
  // `MY_CLAUDE_KEY` survives.
  envScrubExtra: [/^CLAUDE/],
  // No `supervise`, and that is a change: the wrapper this adapter used to
  // launch did not exit when its stdin closed, so every host that died
  // uncleanly leaked one. This one cleans itself up. Measured with ST-ORPH-05
  // and the watchdog off, on the same machine minutes apart: the whole tree was
  // gone 505 ms after a SIGKILLed host, where the old wrapper left two
  // processes alive past the case's 5 s bound. Turning the flag back on is
  // harmless (101 ms), so if a later release regresses, restore it here.
  //
  // No `creationConfig` either. Thinking depth used to reach this engine only
  // through the wrapper's private `_meta.claudeCode.options.maxThinkingTokens`,
  // read once during session construction, which is why it was declared
  // creation-only. This wrapper publishes a `thought_level` config option of
  // its own, and the old declaration actively blocked it: a runtime write was
  // refused as `config:reasoning@runtime` while the creation-time path was
  // accepted and did nothing. Removing it is what makes the engine's own option
  // reachable: CF-06 warns with the declaration in place (both levels refused)
  // and passes without it (both accepted).
  errorPatterns: [{ cause: 'auth', match: 'Authentication required' }],
  /**
   * claude-code reports per-turn token accounting on the prompt response's
   * top-level `usage` object, the same carrier opencode uses.
   *
   * `per-turn` is measured, not inferred, and the measurement had to be built
   * to survive one trap. Across four turns of one session, alternating a terse
   * answer with a verbose one, `outputTokens` went 5 → 241 → 5 → 5: it falls
   * back, which a cumulative counter cannot do. But `totalTokens` rose the
   * whole way — 46233 → 48292 → 48317 → 48342 — because `cachedReadTokens`
   * grows with the conversation. Reading only the total would have concluded
   * `cumulative` and then misreported every turn. The arithmetic settles it:
   * `2 + 5 + 24462 + 21764 = 46233` is that turn's four fields, not a session
   * running total.
   *
   * Only two aliases are declared, because the declaration is additive:
   * `inputTokens`, `outputTokens` and `totalTokens` are already built-in alias
   * names, and restating one creates a second place to keep it right. The two
   * cache names are not built in.
   *
   * There is no `thought` alias and there will not be one. The wrapper's
   * `sessionUsage()` returns exactly five fields, and Anthropic bills extended
   * thinking inside `output_tokens` without breaking it out — so `usage.thought`
   * stays undefined for this engine no matter what is declared here.
   *
   * What stays unfolded, deliberately. The `{used, size}` context gauge on
   * `usage_update`, because fabricating a window gauge from token counts would
   * be invention (decision 024). And `_meta._claude/rateLimit`, which carries a
   * real `resetsAt` — the first any bundled engine has reported — but arrives on
   * a notification under a key naming one vendor, where `TurnResult.quota` reads
   * the prompt response and is documented not to build a cross-engine
   * vocabulary from a single example. A host reads it verbatim from
   * `on('update')` or the transcript meanwhile.
   *
   * Cost needs no declaration at all: `session.usage()` already folds
   * `{cost, currency}` from any engine's `usage_update`, and does so for this
   * engine today.
   */
  usage: {
    source: { kind: 'prompt_response_meta', path: ['usage'] },
    tokens: { cacheRead: ['cachedReadTokens'], cacheCreation: ['cachedWriteTokens'] },
    semantics: 'per-turn',
  },
  /**
   * Probe whether the underlying Claude Code CLI is installed.
   * @returns installed flag, version, and a login hint when unavailable.
   */
  async detect() {
    // The wrapper drives the Claude Code CLI — its presence and login state
    // are what matter, not npx's.
    const version = await tryVersion('claude', ['--version']);
    if (version === undefined) {
      return { installed: false, loginHint: 'install Claude Code, then: claude auth login' };
    }
    return { installed: true, version, loginHint: 'claude auth login' };
  },
};
