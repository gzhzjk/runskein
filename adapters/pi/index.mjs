/**
 * @runskein/adapter-pi — declarative adapter for the pi coding agent.
 *
 * pi speaks no ACP, so this is the first adapter to name a `shim`: runskein spawns
 * `shim.mjs`, which speaks ACP on this side and pi's own RPC protocol to the
 * `pi --mode rpc` children it starts.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run `cmd args…`; resolve stdout, or undefined when unrunnable. The 20s
 * budget matches the other adapters: a first exec on a cold filesystem can be
 * slow enough that a tighter cap would misreport an installed pi as absent. */
function tryVersion(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 20_000 }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim());
    });
  });
}

export default {
  specVersion: 1,
  id: 'pi',
  // `--mode rpc` is pi's headless protocol; the shim adds the per-session
  // arguments, because they differ between a new session, a resume and a fork.
  launch: { command: 'pi', args: ['--mode', 'rpc'], startTimeoutMs: 20_000 },
  // Absolute, resolved from this module: the adapter is registered both as a
  // bundled built-in (no directory to anchor a relative path against) and by
  // directory discovery, and only one form works for both.
  shim: fileURLToPath(new URL('./shim.mjs', import.meta.url)),
  // pi exports its own session markers into every child it runs, and a runskein
  // host started from inside pi would otherwise hand them to a fresh engine.
  // The patterns are anchored: PI_CODING_AGENT_DIR is the user's config
  // directory, not a session marker, and scrubbing it would silently discard
  // their configuration.
  envScrubExtra: [/^PI_CODING_AGENT$/, /^PI_SESSION_(ID|FILE)$/],
  // Order matters: patterns are first-match-wins, and rate-limit is declared
  // ahead of auth everywhere so a throttled request can never be read as a
  // dead credential. pi surfaces throttling through its own turn error —
  // `Internal error: pi ended the turn with an error: 429 status code (no
  // body)` (measured 2026-08-25) — which left `kind` absent until this
  // pattern existed, so a consumer could not tell "wait and retry" from a
  // genuine engine fault.
  errorPatterns: [
    // The status code alone is not enough of a signal: `429` occurs inside
    // token counts, ports and paths, and word boundaries do not exclude any of
    // those. Matched together with the words pi puts around it, which is also
    // the only form that has been measured.
    { cause: 'rate-limit', match: '\\b429 status code\\b' },
    { cause: 'auth', match: 'credentials_not_configured' },
  ],
  /**
   * Probe whether pi is installed and report its version.
   *
   * Authentication is deliberately left unknown: pi authenticates per provider
   * (`pi auth check --provider <name>`), and which provider matters depends on
   * the model the session ends up using, which cannot be known without
   * starting the engine. Reporting `false` here would make the hub refuse
   * sessions that would have worked.
   * @returns installed flag, version, and the login hint.
   */
  async detect() {
    const version = await tryVersion('pi', ['--version']);
    const loginHint = 'configure a provider for pi, then verify: pi auth check --provider <name>';
    if (version === undefined) {
      return { installed: false, loginHint: `install pi, then ${loginHint}` };
    }
    return { installed: true, version, loginHint };
  },
};
