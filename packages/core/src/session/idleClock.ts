/**
 * Injectable timer for the session-idle countdown.
 *
 * The countdown decides when a session lets go of its engine, so the tests that
 * matter most are the ones racing a prompt against expiry. Those races cannot
 * be written against a real clock without being flaky, and a public knob for
 * "fire the idle timer now" would put a test control on the consumer surface.
 * This is the seam instead: internal, injected through the internal options
 * object, with a real-timer default that behaves exactly as before.
 */

/** Schedules the idle countdown. Implementations must be cancellable. */
export interface IdleClock {
  /**
   * Schedule `fire` to run after `ms`.
   * @param ms - delay in milliseconds.
   * @param fire - callback to run on expiry.
   * @returns a cancel function; calling it after expiry is a no-op.
   */
  schedule(ms: number, fire: () => void): () => void;
}

/**
 * The production clock: a real timer that never keeps the process alive.
 *
 * Unref'd because an idle session holding the event loop open would invert the
 * point of the feature — a host with nothing to do could not exit.
 */
export const realIdleClock: IdleClock = {
  schedule(ms: number, fire: () => void): () => void {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};
