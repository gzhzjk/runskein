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
  // upstream refusal with "Authentication required:" whatever its cause, so
  // the auth pattern alone reads a spent quota as a dead credential — which
  // invalidates the cached login, crashes every live session on this engine
  // and retires its process, for a failure that clears itself on its own.
  //
  // Four alternatives, each taken from a payload that was measured rather than
  // imagined, and deliberately spread across different parts of the message.
  // Two spent-quota refusals six days apart:
  //
  //   2026-08-25  ...403 You've reached your usage limit for this billing
  //               cycle. Your quota will be refreshed in the next cycle. To
  //               continue now, purchase extra usage or upgrade your plan:
  //               https://www.kimi.com/membership/subscription?tab=quota
  //   2026-08-31  ...403 You've reached your weekly (7-day) usage limit. Your
  //               quota will reset when the current 7-day window ends. To
  //               continue now, purchase extra usage or upgrade your plan:
  //               https://www.kimi.com/membership/subscription?tab=quota
  //
  // The first declaration took two fragments from the first payload alone, and
  // the rewording broke both at once: a qualifier moved between `your` and
  // `usage limit`, and `refreshed` became `reset`. What the two payloads share
  // is the remediation, which the vendor left untouched while rewriting the
  // description — so anchoring on both halves of the message is what survives.
  //
  // `[^.]{0,40}` admits a qualifier without letting the match run past the end
  // of the sentence. `usage limit` is never matched on its own: it also occurs
  // in sentences about a *configured* limit, which is not a refusal.
  //
  // A rewording must now break all four anchors to send a spent quota back to
  // the auth path. That is a weaker guarantee than it sounds and the reason
  // decision 044 exists: the engine reports no structured status — the frame is
  // `code: -32000` with the 403 only inside the prose — so prose is all there
  // is to match on, and a fifth wording is a field report, not something a
  // hermetic suite can foresee.
  errorPatterns: [
    {
      cause: 'rate-limit',
      match:
        'reached your [^.]{0,40}usage limit|quota will (be refreshed|reset)|purchase extra usage|subscription\\?tab=quota',
    },
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
