/**
 * Idempotent process cleanup.
 *
 * Every command converges on this routine — normal exit, idle-state SIGINT,
 * SIGTERM, and error paths alike. It tracks whether it has run and no-ops
 * on re-entry. For chat, `s.close()` and `hub.quit()` are both attempted
 * regardless of the other's failure, and multiple failures aggregate.
 */
import type { Hub, Session } from '@runskein/core';

const QUIT_TIMEOUT_MS = 3_000;

export class Shutdown {
  private session: Session | undefined;
  private runPromise: Promise<void> | undefined;
  /** Failures captured during cleanup; read by the dispatcher for exit-code classification. */
  readonly errors: unknown[] = [];

  constructor(private readonly hub: Hub) {}

  /**
   * Register the session to close during cleanup; the latest handle wins.
   * Ignored once cleanup has started, so a late attach cannot resurrect work.
   * @param session - the live session.
   */
  attach(session: Session): void {
    if (this.runPromise === undefined) this.session = session;
  }

  get hasRun(): boolean {
    return this.runPromise !== undefined;
  }

  /**
   * Close the session, then quit the hub. Runs exactly once; concurrent and
   * repeated calls share the same outcome. Failures are collected in `errors`
   * rather than thrown, so one failing step never skips the other.
   * @returns a promise that resolves when cleanup has settled.
   */
  run(): Promise<void> {
    // Defer performRun by one microtask so the shared promise is installed
    // before session.close() can synchronously emit callbacks that re-enter.
    return (this.runPromise ??= Promise.resolve().then(() => this.performRun()));
  }

  private async performRun(): Promise<void> {
    const errs: unknown[] = [];
    if (this.session) {
      try {
        await this.session.close();
      } catch (e) {
        errs.push(e);
      }
    }
    try {
      await this.hub.quit(undefined, { timeoutMs: QUIT_TIMEOUT_MS });
    } catch (e) {
      errs.push(e);
    }
    this.errors.push(...(errs.length <= 1 ? errs : [new AggregateError(errs, 'shutdown')]));
  }
}
