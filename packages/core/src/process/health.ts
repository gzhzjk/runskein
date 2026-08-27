/**
 * Health state machine for one engine's process.
 *
 *   stopped/dead ──spawn──▶ starting ──initialize ok──▶ ready
 *   starting/ready ──crash──▶ degraded ──restart ok──▶ ready
 *   degraded ──budget exhausted──▶ dead
 *   ready ──idle reap (graceful)──▶ stopped        (never engine:crash)
 *   any ──explicit quit──▶ dead                    (terminal until next spawn)
 *
 * `not-installed` / `unauthenticated` / `invalid` come from discovery and
 * detect(), before any spawn — they never appear in this machine.
 */
import type { Health } from '../types.js';

export type ProcessHealth = Extract<Health, 'stopped' | 'starting' | 'ready' | 'degraded' | 'dead'>;

const TRANSITIONS: Record<ProcessHealth, readonly ProcessHealth[]> = {
  stopped: ['starting', 'dead'],
  starting: ['ready', 'degraded', 'dead', 'stopped'],
  ready: ['degraded', 'dead', 'stopped'],
  degraded: ['ready', 'dead'], // stays 'degraded' across restart spawns
  dead: ['starting'],
};

export class HealthMachine {
  private current: ProcessHealth = 'stopped';

  /**
   * The current health state of the engine's process.
   * @returns The current ProcessHealth state.
   */
  get state(): ProcessHealth {
    return this.current;
  }

  /**
   * Transition to the given state or throw; an illegal transition is an internal bug.
   * @param next - The ProcessHealth state to move to.
   * @throws `Error` when next is not a legal transition from the current state.
   */
  to(next: ProcessHealth): void {
    if (this.current === next) return;
    if (!TRANSITIONS[this.current].includes(next)) {
      throw new Error(`illegal health transition ${this.current} → ${next}`);
    }
    this.current = next;
  }

  /**
   * True when a child process may exist (spawned and not yet terminal).
   * @returns Whether the state is starting, ready, or degraded.
   */
  get live(): boolean {
    return this.current === 'starting' || this.current === 'ready' || this.current === 'degraded';
  }
}
