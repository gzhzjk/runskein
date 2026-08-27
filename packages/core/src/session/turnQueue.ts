/**
 * FIFO prompt queue: one turn runs at a time per session. Queued turns can be
 * rejected wholesale on cancel or close, while the active turn keeps its own
 * resolution path — that asymmetry is what lets a cancelled turn still resolve
 * with the engine's orderly stop reason.
 */

interface QueuedTurn<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class TurnQueue<T> {
  private queue: QueuedTurn<T>[] = [];
  private active: QueuedTurn<T> | undefined;
  private pumping = false;

  /**
   * @param onDrain - called once the queue has no active or pending turn.
   * Fired from the pump rather than from a turn body, because a turn's own
   * `finally` still sees itself as active — an idle countdown started there
   * would never be scheduled.
   */
  constructor(private readonly onDrain?: () => void) {}

  /** True while a turn is executing. */
  get isActive(): boolean {
    return this.active !== undefined;
  }

  /** Number of queued (not yet started) turns. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queue a turn to run once every turn ahead of it has settled.
   * @param run - the async turn body.
   * @returns the turn's result, or a rejection if the turn is cancelled.
   */
  enqueue(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      void this.pump();
    });
  }

  /**
   * Reject every turn that has not started yet. The active turn is untouched
   * and still settles through its own path.
   * @param makeError - builds a fresh rejection error per turn.
   * @returns how many turns were rejected.
   */
  rejectQueued(makeError: () => unknown): number {
    const victims = this.queue;
    this.queue = [];
    for (const turn of victims) turn.reject(makeError());
    return victims.length;
  }

  /**
   * Reject the active turn's consumer promise. The underlying run() keeps
   * executing — it cannot be interrupted — and its eventual result is dropped.
   * @param error - the rejection reason.
   * @returns true when there was an active turn to reject.
   */
  rejectActive(error: unknown): boolean {
    if (!this.active) return false;
    const active = this.active;
    // Clearing this first makes pump()'s eventual settle a no-op for this turn.
    this.active = undefined;
    active.reject(error);
    return true;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const turn = this.queue.shift();
        if (!turn) {
          this.onDrain?.();
          return;
        }
        this.active = turn;
        try {
          const value = await turn.run();
          if (this.active === turn) turn.resolve(value);
        } catch (e) {
          if (this.active === turn) turn.reject(e);
        } finally {
          if (this.active === turn) this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
