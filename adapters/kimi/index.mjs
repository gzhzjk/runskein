/**
 * @runskein/adapter-kimi — declarative adapter:
 * launch data + a detect() probe, nothing more.
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
  id: 'kimi',
  launch: { command: 'kimi', args: ['acp'], startTimeoutMs: 30_000 },
  // Order matters: patterns are first-match-wins, and kimi prefixes an
  // upstream refusal with "Authentication required:" whatever its cause. A
  // quota exhaustion arrives as `Authentication required: 403 You've reached
  // your usage limit for this billing cycle. Your quota will be refreshed in
  // the next cycle...` (measured 2026-08-25), so the auth pattern alone reads a
  // spent quota as a dead credential — which invalidates the cached login,
  // crashes every live session on this engine and retires its process, for a
  // failure that clears itself.
  //
  // Two alternatives rather than one long anchor: kimi states the condition
  // twice in that message, and either statement alone identifies it. Each is
  // kept long enough to name the condition — `usage limit` on its own also
  // occurs in sentences about a configured limit, which is not a refusal.
  //
  // Nothing here detects a reworded message. A rewording that keeps one of
  // these statements still classifies; one that drops both sends the failure
  // back to the auth path, with no test able to notice. That is a field
  // report, not something a hermetic suite can catch.
  errorPatterns: [
    { cause: 'rate-limit', match: 'reached your usage limit|quota will be refreshed' },
    { cause: 'auth', match: 'Authentication required' },
  ],
  /**
   * Probe whether the engine binary is installed and report its version.
   * @returns installed flag, version, and a login hint when unavailable.
   */
  async detect() {
    const version = await tryVersion('kimi', ['--version']);
    if (version === undefined) {
      return { installed: false, loginHint: 'install kimi, then: kimi acp --login' };
    }
    return { installed: true, version, loginHint: 'kimi acp --login' };
  },
};
